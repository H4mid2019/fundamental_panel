import { describe, expect, it } from "vitest";

import { buildStockIndicators } from "@/lib/indicators/stock";
import { indicatorStrength, sentimentBreakdown } from "@/lib/indicators/score";
import { getStockFixture } from "@/lib/fixtures";

describe("indicatorStrength", () => {
  it("is 0 for missing values", () => {
    expect(indicatorStrength("roe", null)).toBe(0);
  });
  it("is 0.3 for indicators without a threshold rule", () => {
    expect(indicatorStrength("marketCap", 1e9)).toBe(0.3);
  });
  it("grows with distance past a higher-better threshold", () => {
    expect(indicatorStrength("roe", 60)).toBeGreaterThan(
      indicatorStrength("roe", 16),
    );
  });
  it("grows with distance below a lower-better threshold", () => {
    expect(indicatorStrength("pe", 2)).toBeGreaterThan(
      indicatorStrength("pe", 14),
    );
  });
  it("is maximal inside a bullish band", () => {
    expect(indicatorStrength("currentRatio", 2)).toBe(1);
  });
});

describe("sentimentBreakdown", () => {
  it("sums weighted sentiment and counts unavailable indicators", () => {
    const indicators = buildStockIndicators(getStockFixture("AAPL"));
    const b = sentimentBreakdown(indicators);
    expect(b.bullish).toBeGreaterThan(0);
    expect(b.scored + b.unknown).toBe(indicators.length);
    expect(b.bearish).toBeGreaterThanOrEqual(0);
  });

  it("counts null-valued indicators as unknown", () => {
    const sparse = buildStockIndicators({
      ...getStockFixture("AAPL"),
      peRatio: null,
      roe: null,
    });
    const b = sentimentBreakdown(sparse);
    expect(b.unknown).toBeGreaterThanOrEqual(2);
  });
});
