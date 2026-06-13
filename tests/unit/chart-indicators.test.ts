import { describe, expect, it } from "vitest";

import {
  bollinger,
  cvd,
  detectDivergences,
  ema,
  hasOrderFlow,
  macd,
  ofi,
  rsi,
  sma,
  vpin,
  vwap,
} from "@/lib/chart/indicators";
import type { Candle } from "@/lib/chart/types";

/** Build candles from a list of closes (OHLC flat unless overrides given). */
function candlesFrom(
  closes: number[],
  opts: { buyShare?: number; volume?: number } = {},
): Candle[] {
  const { buyShare, volume = 100 } = opts;
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 60,
    open: close,
    high: close,
    low: close,
    close,
    volume,
    buyVolume: buyShare === undefined ? undefined : volume * buyShare,
  }));
}

describe("sma", () => {
  it("averages over the window and starts at index period-1", () => {
    const out = sma(candlesFrom([1, 2, 3, 4, 5]), 3);
    expect(out).toHaveLength(3);
    expect(out[0]?.value).toBeCloseTo(2); // (1+2+3)/3
    expect(out[2]?.value).toBeCloseTo(4); // (3+4+5)/3
  });
});

describe("ema", () => {
  it("seeds with the SMA and tracks the series", () => {
    const out = ema(candlesFrom([1, 2, 3, 4, 5, 6]), 3);
    // First point is the SMA of the first 3 = 2.
    expect(out[0]?.value).toBeCloseTo(2);
    // EMA stays below the latest value while rising.
    expect(out[out.length - 1]?.value).toBeLessThan(6);
    expect(out[out.length - 1]?.value).toBeGreaterThan(4);
  });
});

describe("bollinger", () => {
  it("brackets the basis symmetrically", () => {
    const { upper, middle, lower } = bollinger(
      candlesFrom([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      5,
      2,
    );
    expect(middle.length).toBe(6);
    const i = 0;
    const u = upper[i]?.value ?? 0;
    const m = middle[i]?.value ?? 0;
    const l = lower[i]?.value ?? 0;
    expect(u).toBeGreaterThan(m);
    expect(l).toBeLessThan(m);
    expect(u - m).toBeCloseTo(m - l);
  });
});

describe("rsi", () => {
  it("is 100 for a monotonically rising series", () => {
    const out = rsi(
      candlesFrom([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      14,
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.value).toBeCloseTo(100);
  });

  it("sits near 50 for an alternating flat series", () => {
    const closes = Array.from(
      { length: 40 },
      (_, i) => 100 + (i % 2 === 0 ? 1 : -1),
    );
    const out = rsi(candlesFrom(closes), 14);
    const last = out[out.length - 1]?.value ?? 0;
    expect(last).toBeGreaterThan(30);
    expect(last).toBeLessThan(70);
  });
});

describe("macd", () => {
  it("returns aligned line, signal and histogram", () => {
    const closes = Array.from(
      { length: 60 },
      (_, i) => 100 + Math.sin(i / 3) * 5,
    );
    const { macd: line, signal, histogram } = macd(candlesFrom(closes));
    expect(line.length).toBeGreaterThan(0);
    expect(signal.length).toBe(histogram.length);
    // Histogram equals line − signal at matching times.
    const lineByTime = new Map(line.map((p) => [p.time, p.value]));
    const sigByTime = new Map(signal.map((p) => [p.time, p.value]));
    for (const h of histogram) {
      const expected =
        (lineByTime.get(h.time) ?? 0) - (sigByTime.get(h.time) ?? 0);
      expect(h.value).toBeCloseTo(expected, 6);
    }
  });
});

describe("order-flow guards", () => {
  it("returns empty without taker-buy volume", () => {
    const plain = candlesFrom([1, 2, 3, 4]);
    expect(hasOrderFlow(plain)).toBe(false);
    expect(cvd(plain)).toEqual([]);
    expect(ofi(plain)).toEqual([]);
    expect(vpin(plain)).toEqual([]);
  });
});

describe("cvd", () => {
  it("accumulates positive delta when buyers dominate", () => {
    const out = cvd(candlesFrom([1, 2, 3, 4], { buyShare: 0.75, volume: 100 }));
    expect(out).toHaveLength(4);
    // delta per bar = 2*75 - 100 = +50, cumulative.
    expect(out[0]?.value).toBeCloseTo(50);
    expect(out[3]?.value).toBeCloseTo(200);
  });

  it("decreases when sellers dominate", () => {
    const out = cvd(candlesFrom([1, 2], { buyShare: 0.25, volume: 100 }));
    expect(out[1]?.value).toBeCloseTo(-100); // -50 per bar
  });
});

describe("ofi", () => {
  it("normalizes delta into [-1, 1]", () => {
    const out = ofi(candlesFrom([1, 2], { buyShare: 0.75, volume: 100 }));
    expect(out[0]?.value).toBeCloseTo(0.5); // (150-100)/100
    expect(out[0]?.color).toBeDefined();
  });
});

describe("vpin", () => {
  it("produces values in [0, 1] once enough buckets exist", () => {
    const closes = Array.from({ length: 400 }, (_, i) => 100 + (i % 7));
    const out = vpin(
      candlesFrom(closes, { buyShare: 0.6, volume: 100 }),
      10,
      50,
    );
    expect(out.length).toBeGreaterThan(0);
    for (const p of out) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(p.value).toBeLessThanOrEqual(1);
    }
  });

  it("emits points with the defaults on a typical 500-bar window", () => {
    // Regression: previously window===bucketsTarget left ~0 buckets reaching
    // the rolling window, so VPIN rendered nothing.
    const closes = Array.from({ length: 500 }, (_, i) => 100 + (i % 11));
    const out = vpin(candlesFrom(closes, { buyShare: 0.55, volume: 80 }));
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("vwap", () => {
  it("equals price when volume is constant and price flat", () => {
    const out = vwap(candlesFrom([10, 10, 10], { volume: 5 }));
    expect(out[out.length - 1]?.value).toBeCloseTo(10);
  });

  it("is empty when no bar has volume", () => {
    const noVol = candlesFrom([10, 11]).map((c) => ({ ...c, volume: null }));
    expect(vwap(noVol)).toEqual([]);
  });
});

describe("detectDivergences", () => {
  it("flags a regular bearish divergence (price HH, oscillator LH)", () => {
    // Two price peaks: the second is higher, but the oscillator's second peak
    // is lower — a classic regular bearish divergence.
    const highsPattern = [
      1,
      2,
      3,
      4,
      5,
      4,
      3,
      2,
      1, // peak at idx 4 (price 5)
      2,
      3,
      4,
      5,
      6,
      5,
      4,
      3,
      2, // higher peak at idx 13 (price 6)
    ];
    const candles = candlesFrom(highsPattern);
    // Oscillator: lower at the second peak's time than the first.
    const osc = candles.map((c, i) => ({
      time: c.time,
      value: i === 4 ? 90 : i === 13 ? 70 : 50,
    }));
    const markers = detectDivergences(candles, osc, {
      left: 3,
      right: 3,
      maxBars: 30,
    });
    expect(markers.some((m) => m.kind === "bearish")).toBe(true);
  });
});
