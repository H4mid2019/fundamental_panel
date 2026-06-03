import { describe, expect, it } from "vitest";

import {
  finnhubSchemas,
  getNewsArticles,
  getStockMetrics,
  mapFinnhub,
  mapFinnhubMetrics,
} from "@/lib/providers/finnhub";

describe("mapFinnhub", () => {
  it("maps and dedupes articles by url", () => {
    const out = mapFinnhub([
      {
        id: 1,
        headline: "Headline A",
        source: "Reuters",
        url: "https://x/a",
        datetime: 1_700_000_000,
        summary: "s",
      },
      { id: 2, headline: "Headline A dup", url: "https://x/a", datetime: 1 },
      { id: 3, headline: "Headline B", url: "https://x/b", datetime: 1 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.title).toBe("Headline A");
    expect(out[0]?.publishedAt).toContain("20");
  });
});

describe("finnhub schemas", () => {
  it("requires a headline", () => {
    expect(
      finnhubSchemas.ArticleSchema.safeParse({ headline: "x" }).success,
    ).toBe(true);
    expect(
      finnhubSchemas.ArticleSchema.safeParse({ source: "x" }).success,
    ).toBe(false);
  });
});

describe("mapFinnhubMetrics", () => {
  it("maps metric fields without re-scaling percentages", () => {
    const m = mapFinnhubMetrics({
      peTTM: 48.8,
      pbQuarterly: 6.45,
      psTTM: 20.2,
      roeTTM: 40.8,
      epsTTM: 21.18,
      netProfitMarginTTM: 41.49,
      "totalDebt/totalEquityQuarterly": 0.14,
      revenueGrowthTTMYoy: 85.55,
      beta: 2.2,
    });
    expect(m.peRatio).toBe(48.8);
    expect(m.pbRatio).toBe(6.45);
    expect(m.roe).toBe(40.8); // already a percent — not multiplied
    expect(m.debtToEquity).toBe(0.14);
    expect(m.revenueGrowthYoY).toBe(85.55);
  });
});

describe("getStockMetrics", () => {
  it("returns an empty object when Finnhub is unconfigured", async () => {
    const result = await getStockMetrics("MU");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({});
  });
});

describe("getNewsArticles", () => {
  it("returns fixture articles when no key is configured", async () => {
    const now = Date.parse("2024-06-15T00:00:00Z");
    const result = await getNewsArticles("AAPL", "stock", now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data[0]?.title).toContain("Apple");
    }
  });

  it("returns crypto-flavored fixtures for crypto assets", async () => {
    const now = Date.parse("2024-06-15T00:00:00Z");
    const result = await getNewsArticles("BTC", "crypto", now);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.length).toBeGreaterThan(0);
  });
});
