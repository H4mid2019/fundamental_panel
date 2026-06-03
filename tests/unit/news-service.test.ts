import { describe, expect, it } from "vitest";

import { getNewsAnalysis } from "@/lib/news/service";

describe("getNewsAnalysis", () => {
  it("builds a weighted analysis for a stock from fixtures", async () => {
    const result = await getNewsAnalysis("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const a = result.data;
      expect(a.symbol).toBe("AAPL");
      expect(a.index).toBeGreaterThanOrEqual(-100);
      expect(a.index).toBeLessThanOrEqual(100);
      expect(["positive", "neutral", "negative"]).toContain(a.label);
      expect(a.topTitles.length).toBeGreaterThan(0);
      expect(a.topTitles.length).toBeLessThanOrEqual(20);
      expect(a.articles.length).toBeLessThanOrEqual(12);
      expect(a.fallback).toBe(true);
      // Articles are sorted by descending weight.
      const weights = a.articles.map((x) => x.weight);
      expect([...weights].sort((p, q) => q - p)).toEqual(weights);
    }
  });

  it("builds an analysis for crypto", async () => {
    const result = await getNewsAnalysis("ETH");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.articleCount).toBeGreaterThan(0);
  });
});
