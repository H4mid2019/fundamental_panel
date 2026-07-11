import { describe, expect, it } from "vitest";

import { parseHedgeConfig } from "@/lib/hedge/config";
import { computeMetrics, toHistoryRow } from "@/lib/hedge/metrics/engine";
import { alignedRatio, computePair } from "@/lib/hedge/metrics/pairs";
import {
  buildSurface,
  readSkew,
  type RateContext,
} from "@/lib/hedge/metrics/surface";
import { computeVrp } from "@/lib/hedge/metrics/vrp";
import { fixtureChainSnapshot } from "@/lib/hedge/fixtures";
import { ivAtDelta } from "@/lib/hedge/math/interpolation";
import { delta } from "@/lib/hedge/math/blackScholes";
import type { Candle } from "@/lib/chart/types";
import type { HistoryRow } from "@/lib/hedge/db/repo";
import type {
  ChainSnapshot,
  HedgeContract,
  OptionRight,
} from "@/lib/hedge/types";

import { readFileSync } from "node:fs";

const config = parseHedgeConfig(
  readFileSync("hedge.config.yaml", "utf8").replace(/\r\n/g, "\n"),
  "hedge.config.yaml",
);

const now = new Date("2026-07-11T14:00:00.000Z");
const rates: RateContext = { r: 0.03695, q: 0, fallback: false };

/** A deterministic candle series with a controllable drift and vol. */
function candles(
  count: number,
  start = 100,
  drift = 0.0002,
  vol = 0.01,
  seed = 3,
): Candle[] {
  let state = seed;
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
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1_000_000,
    });
  }
  return out;
}

describe("buildSurface", () => {
  const snapshot = fixtureChainSnapshot("SPY", now);

  it("builds a surface with an ATM IV per expiry", () => {
    const surface = buildSurface(snapshot, rates, config);
    expect(surface).not.toBeNull();
    if (!surface) return;

    expect(surface.spot).toBeGreaterThan(0);
    expect(surface.expiries.length).toBeGreaterThanOrEqual(4);
    for (const e of surface.expiries) {
      expect(e.atmIv).not.toBeNull();
      expect(e.atmIv ?? 0).toBeGreaterThan(0.01);
      expect(e.atmIv ?? 0).toBeLessThan(2);
    }
    // Ascending by DTE — the term interpolation depends on it.
    const dtes = surface.expiries.map((e) => e.dte);
    expect([...dtes].sort((a, b) => a - b)).toEqual(dtes);
  });

  // Out-of-the-money contracts, plus a band around the forward. A blanket
  // "OTM only" rule looks principled and quietly destroys the ATM read on thin
  // chains: near-the-money options have the highest vega on the chain, whichever
  // side of the forward they sit on.
  it("keeps OTM contracts and the near-forward band, but drops deep ITM", () => {
    const surface = buildSurface(snapshot, rates, config);
    expect(surface).not.toBeNull();
    if (!surface) return;

    for (const e of surface.expiries) {
      // The forward is IMPLIED FROM THE CHAIN, not recomputed from spot and a
      // dividend yield we were told. That is the whole point, so the test reads
      // the same number the surface used.
      for (const p of [...e.calls, ...e.puts]) {
        const otm =
          p.right === "call"
            ? p.strike > surface.spot
            : p.strike < surface.spot;
        const nearForward =
          Math.abs(Math.log(p.strike / e.forward)) <= 0.1 + 1e-9;
        expect(otm || nearForward).toBe(true);
      }
    }
  });

  it("brackets the forward, so ATM IV is interpolated and never extrapolated", () => {
    const surface = buildSurface(snapshot, rates, config);
    if (!surface) return;

    for (const e of surface.expiries) {
      if (e.atmIv === null) continue;
      const strikes = [...e.calls, ...e.puts].map((p) => p.strike);
      expect(Math.min(...strikes)).toBeLessThanOrEqual(e.forward);
      expect(Math.max(...strikes)).toBeGreaterThanOrEqual(e.forward);
    }
  });

  it("grades the data quality of a clean chain as good", () => {
    const surface = buildSurface(snapshot, rates, config);
    if (!surface) return;
    // The fixture is arbitrage-free by construction, so nothing should fail
    // parity — if this regresses, the parity check has a sign or units bug.
    expect(surface.quality.parityViolations).toBe(0);
    expect(surface.quality.quality).toBe("good");
  });

  it("rejects a snapshot with no spot instead of computing against null", () => {
    expect(buildSurface({ ...snapshot, spot: null }, rates, config)).toBeNull();
  });
});

/**
 * The data-quality badge answers exactly one question: is this chain stale?
 *
 * A parity violation excludes its strike from every metric either way — that is
 * not negotiable and is not what these tests are about. What they pin down is
 * how the violation is BOOKED, because the badge used to apply two different
 * standards to the identical worthless contract: a penny wing counted as
 * `illiquid` (harmless) when the spread screen caught it, but as bad data when
 * parity caught it first. Thin ETFs were badged `degraded` for having tails.
 */
describe("buildSurface: parity attribution", () => {
  const snapshot = fixtureChainSnapshot("SPY", now);
  const spot = snapshot.spot ?? 0;
  const monthly = snapshot.expiries.find((e) => e.standardMonthly);

  /** A copy of the snapshot with one contract's quote replaced. */
  function withQuote(
    snap: ChainSnapshot,
    expiration: string,
    right: OptionRight,
    strike: number,
    bid: number,
    ask: number,
  ): ChainSnapshot {
    const patch = (cs: HedgeContract[]): HedgeContract[] =>
      cs.map((c) => (c.strike === strike ? { ...c, bid, ask } : c));
    return {
      ...snap,
      expiries: snap.expiries.map((e) =>
        e.expiration !== expiration
          ? e
          : right === "call"
            ? { ...e, calls: patch(e.calls) }
            : { ...e, puts: patch(e.puts) },
      ),
    };
  }

  it("counts a stale leg on an INFORMATIVE quote against the badge", () => {
    expect(monthly).toBeDefined();
    if (!monthly) return;

    // The strike nearest the money: a real premium, a tight market, the highest
    // vega on the chain — precisely the quote the metrics would have used.
    const atm = [...monthly.calls].sort(
      (a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot),
    )[0];
    expect(atm).toBeDefined();
    if (!atm) return;

    // Walk the call $10 away from its put without widening the market, so the
    // pair can no longer satisfy C - P = e^{-rT}(F - K). One strike cannot drag
    // the implied forward with it — the forward is a median, which is the point.
    const bid = (atm.bid ?? 0) + 10;
    const broken = withQuote(
      snapshot,
      monthly.expiration,
      "call",
      atm.strike,
      bid,
      bid + 0.02,
    );

    const base = buildSurface(snapshot, rates, config);
    const surface = buildSurface(broken, rates, config);
    if (!base || !surface) throw new Error("surface should build");

    // A stale leg on a quote worth having IS a stale chain. It must show.
    expect(surface.quality.parityViolations).toBeGreaterThan(0);
    expect(surface.quality.contractsExcluded).toBeGreaterThan(
      base.quality.contractsExcluded,
    );
  });

  it("books a dead wing that fails parity as illiquid, not as bad data", () => {
    const base = buildSurface(snapshot, rates, config);
    if (!base) throw new Error("surface should build");

    // The shortest-dated monthly, whose ladder reaches far enough out that the
    // deepest call has no vega left — which is what makes it a DEAD wing.
    const shortMonthly = [...snapshot.expiries]
      .filter((e) => e.standardMonthly)
      .sort((a, b) => a.dte - b.dte)[0];
    expect(shortMonthly).toBeDefined();
    if (!shortMonthly) return;

    const wingStrike = Math.max(...shortMonthly.calls.map((c) => c.strike));
    const baseExpiry = base.expiries.find(
      (e) => e.expiration === shortMonthly.expiration,
    );
    expect(baseExpiry).toBeDefined();
    if (!baseExpiry) return;

    // It is a candidate (out of the money) and yet the CLEAN chain already books
    // it as illiquid rather than usable, because no volatility is recoverable
    // from it. Asserting that up front is the point: it is what makes this a dead
    // wing rather than merely a distant one, and the whole test rests on it.
    expect(wingStrike).toBeGreaterThan(spot);
    expect(baseExpiry.calls.some((p) => p.strike === wingStrike)).toBe(false);

    // Now stale the deep in-the-money put twin — the leg that actually goes stale
    // on a real chain. The twin is never a candidate itself (deep ITM, far
    // outside the near-forward band), so the only contract parity can condemn at
    // this strike is the worthless wing above it.
    const twin = shortMonthly.puts.find((p) => p.strike === wingStrike);
    expect(twin).toBeDefined();
    if (!twin) return;

    const broken = withQuote(
      snapshot,
      shortMonthly.expiration,
      "put",
      wingStrike,
      (twin.bid ?? 0) - 10,
      (twin.ask ?? 0) - 10,
    );
    const surface = buildSurface(broken, rates, config);
    if (!surface) throw new Error("surface should build");

    // The wing stays excluded from every metric — that is not in question. But it
    // is not evidence of a stale chain: no volatility was recoverable from it
    // anyway, so dropping it costs the surface nothing and must not move the
    // grade. Before the attribution fix this booked a defect and a parity
    // violation, and badged a chain with dead tails `degraded`.
    expect(surface.quality.parityViolations).toBe(0);
    expect(surface.quality.contractsExcluded).toBe(
      base.quality.contractsExcluded,
    );
    expect(surface.quality.contractsIlliquid).toBe(
      base.quality.contractsIlliquid,
    );
    expect(surface.quality.quality).toBe("good");
  });
});

describe("readSkew", () => {
  const snapshot = fixtureChainSnapshot("SPY", now);
  const surface = buildSurface(snapshot, rates, config);

  it("reads a 25-delta put skew off a standard monthly", () => {
    const monthly = surface?.expiries.find(
      (e) => e.usableForSkew && e.dte >= 30,
    );
    expect(monthly).toBeDefined();
    if (!monthly) return;

    const skew = readSkew(monthly);
    expect(skew.bracketed).toBe(true);
    expect(skew.putSkew).not.toBeNull();
    expect(skew.put25Strike).not.toBeNull();
    // The fixture surface has a genuine put skew: OTM puts carry more vol than
    // the money, so the 25-delta put IV must sit ABOVE ATM.
    expect(skew.putSkew ?? 0).toBeGreaterThan(0);
    // ...and calls carry less, so the call-minus-put spread is negative.
    expect(skew.callPutSpread ?? 0).toBeLessThan(0);
  });

  // The trap the two-tenor design exists to close: a weekly's ladder cannot
  // reach 25 delta, so it must report nothing rather than clamp to its edge.
  it("refuses to read skew off a thin weekly", () => {
    const weekly = surface?.expiries.find((e) => !e.usableForSkew);
    expect(weekly).toBeDefined();
    if (!weekly) return;

    const skew = readSkew(weekly);
    expect(skew.bracketed).toBe(false);
    expect(skew.putSkew).toBeNull();
    expect(skew.callPutSpread).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1: the correctness fix. This is the test that proves ignoring the dividend
// yield was not a rounding error.
// ─────────────────────────────────────────────────────────────────────────────
describe("A1: dividend yield in delta", () => {
  // An HYG/TLT-like underlying: the market prices its options with a real ~5.9%
  // dividend yield, so the fixture chain is generated with it too.
  const Q = 0.059;
  const R = 0.04;
  const highYield = fixtureChainSnapshot(
    "TLT",
    now,
    { skew: [30, 60, 90, 180], term: [14] },
    R,
    Q,
  );

  it("shifts every delta by e^(-qT), moving the 25-delta strike", () => {
    const correct = buildSurface(
      highYield,
      { r: R, q: Q, fallback: false },
      config,
    );
    expect(correct).not.toBeNull();
    if (!correct) return;

    // The longest tenor, where e^{-qT} bites hardest.
    const long = [...correct.expiries].sort((a, b) => b.dte - a.dte)[0];
    expect(long).toBeDefined();
    if (!long) return;

    const p25Correct = ivAtDelta(long.puts, 0.25);
    expect(p25Correct).not.toBeNull();
    if (!p25Correct) return;

    // Now recompute every |delta| on the SAME strikes and the SAME IVs, but with
    // the bug: q = 0. Delta scales by e^{-qT}, so the whole curve shifts and the
    // strike that reads 25-delta moves with it.
    const buggy = long.puts.map((p) => ({
      strike: p.strike,
      iv: p.iv,
      absDelta: Math.abs(
        delta(
          { s: correct.spot, k: p.strike, t: long.t, r: R, q: 0, sigma: p.iv },
          "put",
        ),
      ),
    }));
    const p25Buggy = ivAtDelta(buggy, 0.25);
    expect(p25Buggy).not.toBeNull();
    if (!p25Buggy) return;

    // At ~180 days and 5.9%, deltas move by ~3% — enough to pick a different
    // strike off the ladder and read a different IV off the smile.
    const shift = Math.exp(-Q * long.t);
    expect(shift).toBeLessThan(0.98);
    expect(p25Buggy.nearestStrike).not.toBe(p25Correct.nearestStrike);
  });

  // Parity is now IMMUNE to a wrong dividend yield, because the forward is
  // implied from the chain rather than computed from spot and q. Previously a
  // wrong q condemned the entire chain as stale — a wall of false violations
  // that had nothing to do with staleness.
  it("survives a wrong dividend yield: parity no longer depends on q", () => {
    const correct = buildSurface(
      highYield,
      { r: R, q: Q, fallback: false },
      config,
    );
    // Deliberately hand it a completely wrong q. The chain is unchanged.
    const wrongQ = buildSurface(
      highYield,
      { r: R, q: 0, fallback: false },
      config,
    );
    expect(correct).not.toBeNull();
    expect(wrongQ).not.toBeNull();
    if (!correct || !wrongQ) return;

    expect(correct.quality.parityViolations).toBe(0);
    expect(correct.quality.quality).toBe("good");

    // The chain is just as clean, because the wrong q is never consulted.
    expect(wrongQ.quality.parityViolations).toBe(0);
    expect(wrongQ.quality.quality).toBe("good");
  });

  // Better still: the implied forward hands back the carry the market is
  // actually trading against — so the wrong q is not merely ignored, it is
  // CORRECTED, and delta is right even when the caller was wrong.
  it("recovers the true dividend yield from the chain, correcting a wrong input", () => {
    const wrongQ = buildSurface(
      highYield,
      { r: R, q: 0, fallback: false },
      config,
    );
    expect(wrongQ).not.toBeNull();
    if (!wrongQ) return;

    for (const e of wrongQ.expiries) {
      expect(e.impliedQ).not.toBeNull();
      // The fixture was priced at q = 5.9%, and the chain gives it back — to
      // within the cent-rounding of its own quotes, which perturbs the implied
      // forward and therefore q. Recovering 5.9% from a caller who said 0% is
      // the point; the last basis point is the quotes' resolution, not an error.
      expect(Math.abs((e.impliedQ ?? 0) - Q)).toBeLessThan(0.003);
    }
  });

  it("propagates the fallback flag so a guessed rate is never shown as exact", () => {
    const snapshot = fixtureChainSnapshot("SPY", now);
    const surface = buildSurface(
      snapshot,
      { r: 0.042, q: 0, fallback: true },
      config,
    );
    expect(surface?.rates.fallback).toBe(true);
  });
});

describe("computeVrp", () => {
  it("is ATM IV minus the EWMA realized-vol forecast, in vol points", () => {
    const closes = candles(300, 100, 0, 0.01).map((c) => c.close);
    const reading = computeVrp(0.25, closes, 0.94, []);

    expect(reading.ewmaVol).not.toBeNull();
    expect(reading.atmIv30).toBeCloseTo(25, 10);
    expect(reading.vrp).toBeCloseTo(25 - (reading.ewmaVol ?? 0), 10);
  });

  it("calls options rich when implied runs above realized, and cheap when below", () => {
    const closes = candles(300, 100, 0, 0.005).map((c) => c.close);
    const quiet = computeVrp(0.4, closes, 0.94, []); // implied way above realized
    expect(quiet.state).toBe("rich");

    const panicked = computeVrp(0.02, closes, 0.94, []); // implied below realized
    expect(panicked.state).toBe("cheap");
  });

  it("is computable with no IV history at all — the point of it", () => {
    const closes = candles(300).map((c) => c.close);
    const reading = computeVrp(0.2, closes, 0.94, []);
    expect(reading.vrp).not.toBeNull();
    // ...but the z-score is not, until history accumulates.
    expect(reading.vrpZ).toBeNull();
  });

  it("z-scores VRP against its own history once there is enough", () => {
    const closes = candles(300).map((c) => c.close);
    const history = Array.from({ length: 60 }, (_, i) => 2 + (i % 5) * 0.1);
    const reading = computeVrp(0.3, closes, 0.94, history);
    expect(reading.vrpZ).not.toBeNull();
  });

  it("returns nulls when the 30-day point was not bracketed", () => {
    const closes = candles(300).map((c) => c.close);
    const reading = computeVrp(null, closes, 0.94, []);
    expect(reading.vrp).toBeNull();
    expect(reading.state).toBe("unknown");
    // The EWMA half still computes — it needs no chain.
    expect(reading.ewmaVol).not.toBeNull();
  });
});

describe("computePair", () => {
  const pair = {
    id: "test-pair",
    numerator: "A",
    denominator: "B",
    label: "A vs B",
  };

  // The alignment trap: the two legs trade on different calendars, so B is
  // missing a session that A trades. A naive index-zip would pair A's Wednesday
  // close with B's Thursday close from that point on — and stay misaligned
  // forever.
  it("forward-fills the denominator across a missing session", () => {
    const day = 86_400;
    const t0 = 1_700_000_000;
    const bar = (time: number, close: number): Candle => ({
      time,
      open: close,
      high: close,
      low: close,
      close,
      volume: null,
    });

    const a: Candle[] = [0, 1, 2, 3].map((i) => bar(t0 + i * day, 100 + i));
    // B has no bar on day 2 — a holiday on its exchange, not on A's.
    const b: Candle[] = [0, 1, 3].map((i) => bar(t0 + i * day, 50 + i));

    const aligned = alignedRatio(a, b);
    expect(aligned).toHaveLength(4);

    // Day 2 divides A's close (102) by B's LAST KNOWN close (day 1 = 51),
    // not by B's next close (day 3 = 53) — which is what a zip would have done.
    expect(aligned[2]?.value).toBeCloseTo(102 / 51, 10);
    expect(aligned[3]?.value).toBeCloseTo(103 / 53, 10);
    // Timestamps follow the numerator.
    expect(aligned.map((p) => p.time)).toEqual(
      [0, 1, 2, 3].map((i) => t0 + i * day),
    );
  });

  it("drops numerator bars that precede any denominator observation", () => {
    const day = 86_400;
    const t0 = 1_700_000_000;
    const bar = (time: number, close: number): Candle => ({
      time,
      open: close,
      high: close,
      low: close,
      close,
      volume: null,
    });
    const a: Candle[] = [0, 1, 2].map((i) => bar(t0 + i * day, 100));
    const b: Candle[] = [bar(t0 + 2 * day, 50)];

    // Guessing a denominator for the first two bars would be inventing data.
    expect(alignedRatio(a, b)).toHaveLength(1);
  });

  // The A3 guard, end to end.
  it("marks a mean-reverting spread tradeable", () => {
    const day = 86_400;
    const t0 = 1_700_000_000;
    let state = 11;
    const rand = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return (state + 1) / 4294967297 - 0.5;
    };

    // An OU log-spread with a ~15-day half-life.
    const lambda = -Math.LN2 / 15;
    let s = 0;
    const a: Candle[] = [];
    const b: Candle[] = [];
    for (let i = 0; i < 400; i += 1) {
      s += lambda * s + 0.02 * rand() * 2;
      const bClose = 50;
      const aClose = bClose * Math.exp(s);
      const bar = (close: number) => ({
        time: t0 + i * day,
        open: close,
        high: close,
        low: close,
        close,
        volume: null,
      });
      a.push(bar(aClose));
      b.push(bar(bClose));
    }

    const metric = computePair(pair, a, b, 120, 1, 60);
    expect(metric.meanReversion).toBe("pass");
    expect(metric.halfLife).not.toBeNull();
    expect(metric.halfLife ?? 0).toBeGreaterThan(5);
    expect(metric.halfLife ?? 0).toBeLessThan(40);
    expect(metric.tradeable).toBe(true);
    expect(metric.zScore).not.toBeNull();
    expect(metric.series.length).toBeGreaterThan(100);
  });

  // The pair that would otherwise be faded forever, all the way down.
  it("marks a structurally broken, diverging pair NOT tradeable", () => {
    const day = 86_400;
    const t0 = 1_700_000_000;
    const a: Candle[] = [];
    const b: Candle[] = [];
    for (let i = 0; i < 400; i += 1) {
      // A permanently re-rates against B. There is no mean to revert to.
      const aClose = 50 * Math.exp(i * 0.004);
      const bar = (close: number) => ({
        time: t0 + i * day,
        open: close,
        high: close,
        low: close,
        close,
        volume: null,
      });
      a.push(bar(aClose));
      b.push(bar(50));
    }

    const metric = computePair(pair, a, b, 120, 1, 60);
    expect(metric.meanReversion).toBe("fail");
    expect(metric.tradeable).toBe(false);
    // The z-score is still *reported* — it is shown for context, just never
    // ranked as a signal.
    expect(metric.zScore).not.toBeNull();
  });
});

describe("computeMetrics", () => {
  const input = {
    snapshot: fixtureChainSnapshot("SPY", now),
    candles: candles(400),
    benchmarkCandles: candles(400, 100, 0.0002, 0.008, 9),
    rates,
    history: [] as HistoryRow[],
    realIvDays: 0,
  };

  it("computes a full metrics row from a fixture chain, with no network", () => {
    const m = computeMetrics(input, config);
    expect(m).not.toBeNull();
    if (!m) return;

    expect(m.ticker).toBe("SPY");
    expect(m.spot).toBeGreaterThan(0);

    // A2: the 30d and 90d points are bracketed and interpolated.
    expect(m.atm30Bracketed).toBe(true);
    expect(m.atmIv30).not.toBeNull();
    expect(m.atmIv90).not.toBeNull();
    expect(m.termSlope).not.toBeNull();

    // A1: the rate environment is recorded alongside the numbers it produced.
    expect(m.riskFreeRate).toBeCloseTo(rates.r, 10);
    expect(m.ratesFallback).toBe(false);

    // Skew off the front monthly.
    expect(m.skew25dBracketed).toBe(true);
    expect(m.putSkew25d ?? 0).toBeGreaterThan(0);

    // B4/B5.
    expect(m.ewmaVol).not.toBeNull();
    expect(m.realizedVol20d).not.toBeNull();
    expect(m.vrp).not.toBeNull();
    expect(m.vrp).toBeCloseTo((m.atmIv30 ?? 0) * 100 - (m.ewmaVol ?? 0), 8);

    // B6.
    expect(m.dataQuality).toBe("good");
    expect(m.parityViolations).toBe(0);

    // Price context, reused from indicators/priceAction.
    expect(m.pctVs200dma).not.toBeNull();
    expect(m.rsi14).not.toBeNull();
    expect(m.corrSpy60d).not.toBeNull();
  });

  // On day one there is no IV history, so IV rank is a realized-vol rank in
  // disguise. It must say so — it gates two scanners.
  it("flags IV rank as proxied while the history is short", () => {
    const m = computeMetrics(input, config);
    expect(m?.ivRankProxied).toBe(true);
    expect(m?.ivHistoryDays).toBe(0);
  });

  it("stops proxying once enough real IV observations exist", () => {
    // Every series must genuinely vary: a constant history has zero spread, and
    // a z-score against it is a divide-by-zero, not a signal.
    const history: HistoryRow[] = Array.from({ length: 120 }, (_, i) => ({
      ticker: "SPY",
      asOf: `2026-0${1 + (i % 6)}-${String(1 + (i % 28)).padStart(2, "0")}`,
      close: 700 + i,
      atmIv: 15 + (i % 10),
      atmIvProxied: false,
      atmIvBasis: "chain" as const,
      realizedVol20d: 13 + (i % 4),
      ewmaVol: 13 + (i % 3),
      vrp: 2 + (i % 5) * 0.3,
      putSkew25d: 3 + (i % 7) * 0.2,
      callPutSpread: -2 + (i % 5) * 0.1,
      termSlope: 1 + (i % 6) * 0.15,
      source: "scan",
    }));

    const m = computeMetrics({ ...input, history, realIvDays: 120 }, config);
    expect(m?.ivRankProxied).toBe(false);
    expect(m?.ivRank).not.toBeNull();
    expect(m?.ivPercentile).not.toBeNull();
    // With history present, the z-scores populate too.
    expect(m?.putSkewZ).not.toBeNull();
  });

  it("returns null rather than metrics computed against a null spot", () => {
    expect(
      computeMetrics(
        { ...input, snapshot: { ...input.snapshot, spot: null } },
        config,
      ),
    ).toBeNull();
  });
});

describe("toHistoryRow", () => {
  it("records the constant-maturity ATM IV in vol points", () => {
    const m = computeMetrics(
      {
        snapshot: fixtureChainSnapshot("SPY", now),
        candles: candles(400),
        benchmarkCandles: candles(400),
        rates,
        history: [],
        realIvDays: 0,
      },
      config,
    );
    expect(m).not.toBeNull();
    if (!m) return;

    const row = toHistoryRow(m, "2026-07-11");
    expect(row.ticker).toBe("SPY");
    expect(row.asOf).toBe("2026-07-11");
    expect(row.atmIv).toBeCloseTo((m.atmIv30 ?? 0) * 100, 10);
    expect(row.atmIvProxied).toBe(false);
    expect(row.vrp).toBe(m.vrp);
    expect(row.ewmaVol).toBe(m.ewmaVol);
    expect(row.source).toBe("scan");
  });

  // The one thing that must never happen: a proxied value quietly certifying
  // itself as real history and maturing the IV rank on its own say-so.
  it("marks the row proxied when there was no bracketed ATM IV", () => {
    const m = computeMetrics(
      {
        snapshot: fixtureChainSnapshot("SPY", now),
        candles: candles(400),
        benchmarkCandles: candles(400),
        rates,
        history: [],
        realIvDays: 0,
      },
      config,
    );
    if (!m) return;

    const row = toHistoryRow({ ...m, atmIv30: null }, "2026-07-11");
    expect(row.atmIv).toBeNull();
    expect(row.atmIvProxied).toBe(true);
  });
});
