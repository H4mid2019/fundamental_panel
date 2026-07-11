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
      const forward = surface.spot * Math.exp((rates.r - rates.q) * e.t);
      for (const p of [...e.calls, ...e.puts]) {
        const otm =
          p.right === "call"
            ? p.strike > surface.spot
            : p.strike < surface.spot;
        const nearForward =
          Math.abs(Math.log(p.strike / forward)) <= 0.1 + 1e-9;
        expect(otm || nearForward).toBe(true);
      }
    }
  });

  it("brackets the forward, so ATM IV is interpolated and never extrapolated", () => {
    const surface = buildSurface(snapshot, rates, config);
    if (!surface) return;

    for (const e of surface.expiries) {
      if (e.atmIv === null) continue;
      const forward = surface.spot * Math.exp((rates.r - rates.q) * e.t);
      const strikes = [...e.calls, ...e.puts].map((p) => p.strike);
      expect(Math.min(...strikes)).toBeLessThanOrEqual(forward);
      expect(Math.max(...strikes)).toBeGreaterThanOrEqual(forward);
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

  // The bug is self-revealing once B6 is in place, which is a nice property:
  // put-call parity is q-sensitive, so pricing a chain with the wrong dividend
  // yield does not merely bias the skew — it makes the entire chain look stale.
  it("makes put-call parity reject the whole chain when q is wrong", () => {
    const correct = buildSurface(
      highYield,
      { r: R, q: Q, fallback: false },
      config,
    );
    const wrong = buildSurface(
      highYield,
      { r: R, q: 0, fallback: false },
      config,
    );
    expect(correct).not.toBeNull();
    expect(wrong).not.toBeNull();
    if (!correct || !wrong) return;

    expect(correct.quality.parityViolations).toBe(0);
    expect(correct.quality.quality).toBe("good");

    expect(wrong.quality.parityViolations).toBeGreaterThan(0);
    expect(wrong.quality.quality).toBe("poor");
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
