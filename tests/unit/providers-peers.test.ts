import { afterEach, describe, expect, it, vi } from "vitest";

const { mockedRecommendations, mockedQuote } = vi.hoisted(() => ({
  mockedRecommendations: vi.fn(),
  mockedQuote: vi.fn(),
}));

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    recommendationsBySymbol = mockedRecommendations;
    quote = mockedQuote;
  },
}));

import {
  getQuoteStats,
  getRecommendedPeers,
  MAX_PEERS,
} from "@/lib/providers/peers";

afterEach(() => vi.clearAllMocks());

describe("getRecommendedPeers", () => {
  it("returns the recommended symbols, excluding the asset itself", async () => {
    mockedRecommendations.mockResolvedValue({
      symbol: "RKLB",
      recommendedSymbols: [
        { symbol: "AVAV", score: 0.28 },
        { symbol: "rklb", score: 0.27 }, // self, any case
        { symbol: "RDW", score: 0.25 },
        { symbol: "BA", score: 0.2 },
        { symbol: "FLY", score: 0.19 },
        { symbol: "VOYG", score: 0.18 },
        { symbol: "LUNR", score: 0.17 },
      ],
    } as never);

    const result = await getRecommendedPeers("RKLB");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(["AVAV", "RDW", "BA", "FLY", "VOYG"]);
      expect(result.data.length).toBeLessThanOrEqual(MAX_PEERS);
    }
  });

  it("errors when the upstream call fails", async () => {
    mockedRecommendations.mockRejectedValue(new Error("offline"));
    const result = await getRecommendedPeers("RKLB");
    expect(result.ok).toBe(false);
  });

  it("errors when the payload has an unexpected shape", async () => {
    mockedRecommendations.mockResolvedValue({ nope: true } as never);
    const result = await getRecommendedPeers("RKLB");
    expect(result.ok).toBe(false);
  });
});

describe("getQuoteStats", () => {
  it("computes % of 52-week high and passes the 1-year change through", async () => {
    mockedQuote.mockResolvedValue([
      {
        symbol: "RKLB",
        regularMarketPrice: 108.23,
        fiftyTwoWeekHigh: 151,
        fiftyTwoWeekChangePercent: 318.29,
      },
      { symbol: "AVAV" }, // sparse quote → null stats
    ] as never);

    const stats = await getQuoteStats(["RKLB", "AVAV"]);
    expect(stats.RKLB?.pctOf52wHigh).toBeCloseTo(71.7, 1);
    expect(stats.RKLB?.oneYearChangePct).toBeCloseTo(318.3, 1);
    expect(stats.AVAV?.pctOf52wHigh).toBeNull();
    expect(stats.AVAV?.oneYearChangePct).toBeNull();
  });

  it("degrades to an empty map on failure", async () => {
    mockedQuote.mockRejectedValue(new Error("offline"));
    await expect(getQuoteStats(["RKLB"])).resolves.toEqual({});
  });

  it("returns an empty map for an empty symbol list without calling Yahoo", async () => {
    await expect(getQuoteStats([])).resolves.toEqual({});
    expect(mockedQuote).not.toHaveBeenCalled();
  });
});
