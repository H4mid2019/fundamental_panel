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
});
