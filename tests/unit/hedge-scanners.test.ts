import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/chart/types";
import { parseHedgeConfig } from "@/lib/hedge/config";
import { fixtureChainSnapshot } from "@/lib/hedge/fixtures";
import { computeMetrics } from "@/lib/hedge/metrics/engine";
import { buildSurface, type RateContext } from "@/lib/hedge/metrics/surface";
import type { DividendProfile } from "@/lib/hedge/providers/underlying";
import {
  computeTailHedgeSignal,
  earlyAssignmentRisk,
  pickByDelta,
  pickByMoneyness,
  rankSetups,
  runScanners,
  type ScanContext,
  type Setup,
} from "@/lib/hedge/scanners";

const config = parseHedgeConfig(
  readFileSync("hedge.config.yaml", "utf8").replace(/\r\n/g, "\n"),
  "hedge.config.yaml",
);

const now = new Date("2026-07-11T14:00:00.000Z");
const rates: RateContext = { r: 0.037, q: 0, fallback: false };

const noDividends: DividendProfile = {
  q: 0,
  fallback: false,
  history: [],
  cadenceDays: null,
  nextExDate: null,
  nextAmount: null,
};

function candles(
  count: number,
  start = 100,
  drift = 0.0006,
  vol = 0.008,
): Candle[] {
  let state = 5;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state + 1) / 4294967297 - 0.5;
  };
  const out: Candle[] = [];
  let price = start;
  const startSec = Math.floor(now.getTime() / 1000) - count * 86_400;
  for (let i = 0; i < count; i += 1) {
    price *= Math.exp(drift + vol * rand() * 2);
    out.push({
      time: startSec + i * 86_400,
      open: price,
      high: price * 1.004,
      low: price * 0.996,
      close: price,
      volume: 1e6,
    });
  }
  return out;
}

/** A full scan context for one fixture ticker. */
function context(
  ticker: string,
  overrides: Partial<ScanContext["metrics"]> = {},
  dividends: DividendProfile = noDividends,
): ScanContext {
  const snapshot = fixtureChainSnapshot(ticker, now);
  const surface = buildSurface(snapshot, rates, config);
  if (!surface) throw new Error("no surface");

  const metrics = computeMetrics(
    {
      snapshot,
      candles: candles(400),
      benchmarkCandles: candles(400),
      rates,
      history: [],
      realIvDays: 0,
    },
    config,
  );
  if (!metrics) throw new Error("no metrics");

  return {
    metrics: { ...metrics, ...overrides },
    surface,
    dividends,
    config,
  };
}

describe("pickByDelta / pickByMoneyness", () => {
  const ctx = context("SPY");
  const expiry = ctx.surface.expiries.find((e) => e.usableForSkew);

  it("returns a REAL listed strike, not an interpolated one", () => {
    expect(expiry).toBeDefined();
    if (!expiry) return;

    const pick = pickByDelta(expiry.calls, 0.25, 0.2, 0.3);
    expect(pick).not.toBeNull();
    if (!pick) return;

    // A setup quoting a strike that does not exist is worse than no setup.
    expect(expiry.calls.some((c) => c.strike === pick.strike)).toBe(true);
    expect(pick.absDelta).toBeGreaterThanOrEqual(0.2);
    expect(pick.absDelta).toBeLessThanOrEqual(0.3);
  });

  it("returns null when nothing falls inside the delta band", () => {
    if (!expiry) return;
    expect(pickByDelta(expiry.calls, 0.99, 0.98, 0.999)).toBeNull();
  });

  it("picks the listed strike closest to a target moneyness", () => {
    if (!expiry) return;
    const spot = ctx.surface.spot;
    const pick = pickByMoneyness(expiry.puts, spot, -7);
    expect(pick).not.toBeNull();
    if (!pick) return;
    expect(pick.strike).toBeLessThan(spot);
    // Within one strike increment of the 7%-below-spot target.
    expect(Math.abs(pick.strike - spot * 0.93) / spot).toBeLessThan(0.03);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B7 — the ex-dividend assignment penalty.
// ─────────────────────────────────────────────────────────────────────────────
describe("earlyAssignmentRisk", () => {
  const dividends: DividendProfile = {
    q: 0.02,
    fallback: false,
    history: [],
    cadenceDays: 91,
    nextExDate: "2026-08-01",
    nextAmount: 0.5,
  };

  // The textbook condition: exercise early only if the extrinsic value you throw
  // away is worth less than the dividend you capture.
  it("flags a short call whose extrinsic value is below the dividend", () => {
    // Deep ITM: spot 110, strike 100, mid 10.20 → extrinsic 0.20 < 0.50 dividend.
    const risk = earlyAssignmentRisk(
      10.2,
      110,
      100,
      "2026-09-18",
      dividends,
      1,
    );
    expect(risk.extrinsic).toBeCloseTo(0.2, 6);
    expect(risk.atRisk).toBe(true);
  });

  // "There is a dividend in the tenor" is NOT a risk on its own — every quarterly
  // payer has one, and flagging them all would make the penalty meaningless.
  it("does not flag a call with plenty of extrinsic value left", () => {
    // Spot 110, strike 100, mid 13.00 → extrinsic 3.00, far above the 0.50 dividend.
    const risk = earlyAssignmentRisk(13, 110, 100, "2026-09-18", dividends, 1);
    expect(risk.extrinsic).toBeCloseTo(3, 6);
    expect(risk.atRisk).toBe(false);
  });

  it("does not flag when the ex-date falls after expiry", () => {
    const risk = earlyAssignmentRisk(
      10.2,
      110,
      100,
      "2026-07-20",
      dividends,
      1,
    );
    expect(risk.atRisk).toBe(false);
  });

  it("does not flag a non-payer", () => {
    const risk = earlyAssignmentRisk(
      10.2,
      110,
      100,
      "2026-09-18",
      noDividends,
      1,
    );
    expect(risk.atRisk).toBe(false);
    expect(risk.dividend).toBeNull();
  });

  it("respects the buffer, demanding a margin of safety", () => {
    // Extrinsic 0.60 clears a 1.0x buffer on a 0.50 dividend, but not a 2.0x one.
    expect(
      earlyAssignmentRisk(10.6, 110, 100, "2026-09-18", dividends, 1).atRisk,
    ).toBe(false);
    expect(
      earlyAssignmentRisk(10.6, 110, 100, "2026-09-18", dividends, 2).atRisk,
    ).toBe(true);
  });
});

describe("collar scanner", () => {
  it("emits a collar with real strikes, a floor and a cap", () => {
    const setups = runScanners(context("SPY"));
    const collar = setups.find((s) => s.scanner === "collar");
    expect(collar).toBeDefined();
    if (!collar) return;

    expect(collar.legs).toHaveLength(2);
    const [short, long] = collar.legs;
    expect(short?.action).toBe("sell");
    expect(short?.right).toBe("call");
    expect(long?.action).toBe("buy");
    expect(long?.right).toBe("put");

    // The floor is below spot and the cap above it, or it is not a collar.
    expect(collar.stats.floorPct ?? 0).toBeLessThan(0);
    expect(collar.stats.capPct ?? 0).toBeGreaterThan(0);
    expect(collar.stats.ivSpread).not.toBeNull();
  });

  // The penalties are what separate a screener from a trade list.
  it("penalizes early-assignment risk and says why", () => {
    const risky: DividendProfile = {
      q: 0.03,
      fallback: false,
      history: [],
      cadenceDays: 30,
      nextExDate: "2026-08-01",
      // Absurdly large, so the short call's extrinsic cannot possibly cover it.
      nextAmount: 50,
    };

    const clean = runScanners(context("SPY")).find(
      (s) => s.scanner === "collar",
    );
    const penalized = runScanners(context("SPY", {}, risky)).find(
      (s) => s.scanner === "collar",
    );
    expect(clean).toBeDefined();
    expect(penalized).toBeDefined();
    if (!clean || !penalized) return;

    expect(penalized.score).toBeLessThan(clean.score);
    expect(penalized.warnings.some((w) => /assignment/i.test(w))).toBe(true);
  });
});

describe("put debit spread scanner", () => {
  it("does not fire without a skew z-score — it is defined by the skew", () => {
    const setups = runScanners(context("SPY", { putSkewZ: null }));
    expect(setups.some((s) => s.scanner === "putDebitSpread")).toBe(false);
  });

  it("fires on a steep skew and reports a payoff ratio", () => {
    const setups = runScanners(context("SPY", { putSkewZ: 2.2 }));
    const spread = setups.find((s) => s.scanner === "putDebitSpread");
    expect(spread).toBeDefined();
    if (!spread) return;

    expect(spread.legs).toHaveLength(2);
    // Long strike above the short: a spread, not a single leg.
    expect(spread.legs[0]?.strike ?? 0).toBeGreaterThan(
      spread.legs[1]?.strike ?? 0,
    );
    expect(spread.stats.payoffRatio ?? 0).toBeGreaterThan(0);
    expect(spread.stats.netDebit ?? 0).toBeGreaterThan(0);
  });
});

describe("protective put scanner", () => {
  it("requires BOTH cheap vol and an uptrend", () => {
    // Cheap vol, but the price is below its 200-day mean: no trade.
    const downtrend = runScanners(
      context("SPY", { ivRank: 10, pctVs200dma: -5 }),
    );
    expect(downtrend.some((s) => s.scanner === "protectivePut")).toBe(false);

    // Uptrend, but vol is expensive: no trade.
    const richVol = runScanners(context("SPY", { ivRank: 80, pctVs200dma: 8 }));
    expect(richVol.some((s) => s.scanner === "protectivePut")).toBe(false);

    // Both: a trade.
    const good = runScanners(context("SPY", { ivRank: 10, pctVs200dma: 8 }));
    expect(good.some((s) => s.scanner === "protectivePut")).toBe(true);
  });

  // The honesty requirement, enforced at the setup level.
  it("warns when IV rank is proxied, and when VRP contradicts it", () => {
    const setups = runScanners(
      context("SPY", {
        ivRank: 10,
        pctVs200dma: 8,
        ivRankProxied: true,
        ivHistoryDays: 3,
        // IV rank says "cheap"; VRP says implied is running ABOVE realized.
        vrp: 4.5,
      }),
    );
    const put = setups.find((s) => s.scanner === "protectivePut");
    expect(put).toBeDefined();
    if (!put) return;

    expect(put.proxied).toBe(true);
    expect(put.warnings.some((w) => /proxied/i.test(w))).toBe(true);
    expect(put.warnings.some((w) => /VRP/.test(w))).toBe(true);
  });
});

describe("call credit scanner", () => {
  it("always attaches a protective wing — never a naked short call", () => {
    const setups = runScanners(context("SPY", { ivRank: 85, pctVs200dma: 12 }));
    const credit = setups.find((s) => s.scanner === "callCredit");
    expect(credit).toBeDefined();
    if (!credit) return;

    expect(credit.legs).toHaveLength(2);
    const sell = credit.legs.find((l) => l.action === "sell");
    const buy = credit.legs.find((l) => l.action === "buy");
    expect(sell?.right).toBe("call");
    expect(buy?.right).toBe("call");
    // The long wing is further out than the short leg, so the loss is bounded.
    expect(buy?.strike ?? 0).toBeGreaterThan(sell?.strike ?? 0);
    expect(credit.stats.maxLoss ?? 0).toBeGreaterThan(0);
  });

  it("quotes yield on capital at RISK, not on notional", () => {
    const setups = runScanners(context("SPY", { ivRank: 85, pctVs200dma: 12 }));
    const credit = setups.find((s) => s.scanner === "callCredit");
    if (!credit) return;

    const c = credit.stats.credit ?? 0;
    const maxLoss = credit.stats.maxLoss ?? 1;
    // Quoting it on notional would flatter the trade enormously.
    expect(credit.stats.yieldOnRisk).toBeCloseTo((c / maxLoss) * 100, 0);
  });
});

describe("tail hedge composite", () => {
  // Credit stressed + equity vol asleep + flat skew = hedges on sale.
  it("fires when credit is stressed while equity vol stays complacent", () => {
    const signal = computeTailHedgeSignal(
      {
        vixTerm: [
          { symbol: "^VIX9D", value: 11 },
          { symbol: "^VIX6M", value: 21 }, // steep contango = complacency
        ],
        creditDivergencePct: -3, // HYG bleeding vs LQD
        spyPutSkew: 0.5, // flat skew: the tail is not bid
        spyIvRank: 8,
      },
      1.5,
    );

    expect(signal.firing).toBe(true);
    expect(signal.composite).toBeGreaterThan(1.5);
    expect(signal.vixSlope).toBeGreaterThan(0);
    expect(signal.narrative).toMatch(/credit/i);
  });

  // The sign on skew is the subtle part: a STEEP skew means the tail is already
  // expensive, so there is nothing on sale, even if credit is soft.
  it("does not fire when the tail is already bid", () => {
    const signal = computeTailHedgeSignal(
      {
        vixTerm: [
          { symbol: "^VIX9D", value: 24 },
          { symbol: "^VIX6M", value: 22 }, // backwardation: fear is here
        ],
        creditDivergencePct: -1,
        spyPutSkew: 8, // steep: puts already expensive
        spyIvRank: 70,
      },
      1.5,
    );

    expect(signal.firing).toBe(false);
    expect(signal.narrative).toMatch(/No tail-hedge signal/);
  });

  it("says so plainly when there is not enough context", () => {
    const signal = computeTailHedgeSignal(
      {
        vixTerm: [],
        creditDivergencePct: null,
        spyPutSkew: null,
        spyIvRank: null,
      },
      1.5,
    );
    expect(signal.firing).toBe(false);
    expect(signal.narrative).toMatch(/Insufficient/);
  });
});

describe("rankSetups", () => {
  const make = (
    scanner: Setup["scanner"],
    ticker: string,
    score: number,
  ): Setup => ({
    scanner,
    ticker,
    score,
    legs: [],
    stats: {},
    summary: "",
    warnings: [],
    proxied: false,
    ratesFallback: false,
    dataQuality: "good",
    signalHash: `${scanner}-${ticker}`,
  });

  it("groups by scanner, sorts best-first and caps at topN", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      make("collar", `T${i}`, i),
    );
    const ranked = rankSetups([...many, make("callCredit", "AAPL", 5)], config);

    expect(ranked.collar).toHaveLength(config.scanners.topN);
    expect(ranked.collar[0]?.score).toBe(39); // best first
    expect(ranked.callCredit).toHaveLength(1);
    expect(ranked.protectivePut).toEqual([]);
  });
});
