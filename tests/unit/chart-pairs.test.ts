import { describe, expect, it } from "vitest";

import { computeRatioCandles, ratioLabel } from "@/lib/chart/pairs";
import type { Candle } from "@/lib/chart/types";

function bar(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, volume: null };
}

describe("ratioLabel", () => {
  it("joins numerator and denominator with a slash", () => {
    expect(ratioLabel("BTC", "GOLD")).toBe("BTC / GOLD");
  });
});

describe("computeRatioCandles", () => {
  it("divides aligned closes", () => {
    const num = [bar(60, 100), bar(120, 110)];
    const den = [bar(60, 10), bar(120, 10)];
    const out = computeRatioCandles(num, den);
    expect(out).toHaveLength(2);
    expect(out[0]?.close).toBeCloseTo(10);
    expect(out[1]?.close).toBeCloseTo(11);
  });

  it("forward-fills a sparse (slower) denominator", () => {
    // Denominator only updates at t=60; the t=120 numerator bar reuses it.
    const num = [bar(60, 100), bar(120, 200)];
    const den = [bar(60, 10)];
    const out = computeRatioCandles(num, den);
    expect(out).toHaveLength(2);
    expect(out[1]?.close).toBeCloseTo(20);
  });

  it("drops numerator bars before the first denominator value", () => {
    const num = [bar(60, 100), bar(120, 100)];
    const den = [bar(120, 10)];
    const out = computeRatioCandles(num, den);
    expect(out).toHaveLength(1);
    expect(out[0]?.time).toBe(120);
  });

  it("recomputes high/low so wicks never invert", () => {
    const num: Candle[] = [
      { time: 60, open: 100, high: 120, low: 90, close: 110, volume: null },
    ];
    const den = [bar(60, 10)];
    const [out] = computeRatioCandles(num, den);
    expect(out?.high).toBeGreaterThanOrEqual(out?.open ?? 0);
    expect(out?.high).toBeGreaterThanOrEqual(out?.close ?? 0);
    expect(out?.low).toBeLessThanOrEqual(out?.open ?? 0);
    expect(out?.low).toBeLessThanOrEqual(out?.close ?? 0);
  });

  it("returns empty when either leg is empty", () => {
    expect(computeRatioCandles([], [bar(60, 1)])).toEqual([]);
    expect(computeRatioCandles([bar(60, 1)], [])).toEqual([]);
  });
});
