import { describe, expect, it } from "vitest";

import { classify, THRESHOLDS } from "@/lib/indicators/thresholds";

describe("classify", () => {
  it("returns unknown for null values", () => {
    expect(classify("pe", null)).toBe("unknown");
  });

  it("returns neutral for indicators without a rule", () => {
    expect(THRESHOLDS.marketCap).toBeUndefined();
    expect(classify("marketCap", 1_000_000)).toBe("neutral");
  });

  describe("higherBetter (ROE)", () => {
    it("is bullish at or above the bullish level", () => {
      expect(classify("roe", 15)).toBe("bullish");
      expect(classify("roe", 30)).toBe("bullish");
    });
    it("is bearish at or below the bearish level", () => {
      expect(classify("roe", 5)).toBe("bearish");
      expect(classify("roe", 1)).toBe("bearish");
    });
    it("is neutral in between", () => {
      expect(classify("roe", 10)).toBe("neutral");
    });
  });

  describe("lowerBetter (P/E)", () => {
    it("is bullish at or below the bullish level", () => {
      expect(classify("pe", 15)).toBe("bullish");
      expect(classify("pe", 8)).toBe("bullish");
    });
    it("is bearish at or above the bearish level", () => {
      expect(classify("pe", 35)).toBe("bearish");
      expect(classify("pe", 50)).toBe("bearish");
    });
    it("is neutral in between", () => {
      expect(classify("pe", 25)).toBe("neutral");
    });
    it("is bearish for negative valuation ratios (losses, not cheapness)", () => {
      expect(classify("pe", -343.1)).toBe("bearish");
      expect(classify("pb", -2)).toBe("bearish");
      expect(classify("evEbitda", -10)).toBe("bearish");
      expect(classify("debtToEquity", -0.4)).toBe("bearish");
    });
    it("still treats low non-negative values as bullish", () => {
      expect(classify("pe", 0)).toBe("bullish");
    });
  });

  describe("band (PEG)", () => {
    it("is bullish inside the sweet-spot range", () => {
      expect(classify("peg", 0)).toBe("bullish");
      expect(classify("peg", 0.5)).toBe("bullish");
      expect(classify("peg", 1)).toBe("bullish");
    });
    it("is bearish above the acceptable range", () => {
      expect(classify("peg", 3)).toBe("bearish");
    });
    it("is bearish below the acceptable range", () => {
      expect(classify("peg", -1)).toBe("bearish");
    });
    it("is neutral inside acceptable but outside bullish", () => {
      expect(classify("peg", 1.5)).toBe("neutral");
    });
  });
});
