import { afterEach, describe, expect, it, vi } from "vitest";

const { mockedQuote, mockedSummary } = vi.hoisted(() => ({
  mockedQuote: vi.fn(),
  mockedSummary: vi.fn(),
}));

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    quote = mockedQuote;
    quoteSummary = mockedSummary;
  },
}));

import {
  getIndexFundamentals,
  getYahooFundamentals,
} from "@/lib/providers/yahoo";

afterEach(() => vi.clearAllMocks());

describe("getIndexFundamentals", () => {
  it("enriches the fixture with live quote fields", async () => {
    mockedQuote.mockResolvedValue({
      shortName: "S&P 500 Live",
      regularMarketPrice: 5500,
      currency: "USD",
      regularMarketChangePercent: 0.5,
      trailingPE: 25,
    } as never);

    const result = await getIndexFundamentals("^GSPC");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("S&P 500 Live");
      expect(result.data.price).toBe(5500);
      expect(result.data.peRatio).toBe(25);
    }
  });

  it("falls back to the fixture when the quote throws", async () => {
    mockedQuote.mockRejectedValue(new Error("network"));
    const result = await getIndexFundamentals("^GSPC");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.symbol).toBe("^GSPC");
  });
});

describe("getYahooFundamentals", () => {
  it("maps quoteSummary modules with correct unit conversions", async () => {
    mockedSummary.mockResolvedValue({
      price: {
        regularMarketPrice: 311.22,
        regularMarketChangePercent: -0.0126, // fraction -> -1.3%
        currency: "USD",
        longName: "Apple Inc.",
        marketCap: 4.57e12,
      },
      summaryDetail: {
        trailingPE: 37.68,
        priceToSalesTrailing12Months: 10.13,
        dividendYield: 0.0034, // -> 0.3%
        payoutRatio: 0.1259, // -> 12.6%
      },
      defaultKeyStatistics: {
        priceToBook: 42.87,
        pegRatio: 2.72,
        enterpriseToEbitda: 29.04,
        trailingEps: 8.26,
        beta: 1.065,
      },
      financialData: {
        returnOnEquity: 1.4147, // -> 141.5%
        profitMargins: 0.2715, // -> 27.2%
        revenueGrowth: 0.166, // -> 16.6%
        debtToEquity: 79.548, // percent -> 0.8x
        freeCashflow: 1.01e11,
      },
      assetProfile: { sector: "Technology" },
    } as never);

    const result = await getYahooFundamentals("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const f = result.data;
      expect(f.peRatio).toBe(37.68);
      expect(f.changePct).toBe(-1.3);
      expect(f.dividendYield).toBe(0.3);
      expect(f.roe).toBe(141.5);
      expect(f.debtToEquity).toBe(0.8);
      expect(f.freeCashFlow).toBe(1.01e11);
      expect(f.sector).toBe("Technology");
      // Not provided by these modules; left for Finnhub backfill.
      expect(f.assetTurnover).toBeNull();
    }
  });

  it("errors (so callers can fall back) when there is no data", async () => {
    mockedSummary.mockResolvedValue({ price: {} } as never);
    const result = await getYahooFundamentals("ZZZZ");
    expect(result.ok).toBe(false);
  });

  it("derives negative P/E and PEG for loss-makers (Yahoo omits them)", async () => {
    // Modeled on RKLB: negative trailing EPS, no trailingPE/pegRatio fields.
    mockedSummary.mockResolvedValue({
      price: {
        regularMarketPrice: 108.23,
        currency: "USD",
        longName: "Rocket Lab Corporation",
        marketCap: 5.2e10,
      },
      summaryDetail: { priceToSalesTrailing12Months: 92.2 },
      defaultKeyStatistics: { trailingEps: -0.32 },
      financialData: { earningsGrowth: 0.195 },
      assetProfile: { sector: "Industrials" },
    } as never);

    const result = await getYahooFundamentals("RKLB");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.peRatio).toBeCloseTo(-338.22, 2); // 108.23 / -0.32
      expect(result.data.pegRatio).toBeCloseTo(-17.34, 2); // -338.22 / 19.5
      expect(result.data.eps).toBe(-0.32);
    }
  });

  it("falls back to analyst trend growth for PEG when earningsGrowth is missing", async () => {
    mockedSummary.mockResolvedValue({
      price: { regularMarketPrice: 108.23, marketCap: 5.2e10 },
      defaultKeyStatistics: { trailingEps: -0.32 },
      financialData: {},
      earningsTrend: {
        trend: [
          { period: "0y", growth: 0.373 },
          { period: "+1y", growth: 0.9364 },
        ],
      },
    } as never);

    const result = await getYahooFundamentals("RKLB");
    expect(result.ok).toBe(true);
    // P/E -338.22 over the +1y growth estimate (93.6%).
    if (result.ok) expect(result.data.pegRatio).toBeCloseTo(-3.61, 2);
  });

  it("prefers Yahoo's own trailingPE over the derived value", async () => {
    mockedSummary.mockResolvedValue({
      price: { regularMarketPrice: 100, marketCap: 1e9 },
      summaryDetail: { trailingPE: 20 },
      defaultKeyStatistics: { trailingEps: 4 }, // would derive 25 otherwise
    } as never);

    const result = await getYahooFundamentals("TEST");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.peRatio).toBe(20);
  });
});
