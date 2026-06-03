import { afterEach, describe, expect, it, vi } from "vitest";

const { mockedQuote } = vi.hoisted(() => ({ mockedQuote: vi.fn() }));

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    quote = mockedQuote;
  },
}));

import { getIndexFundamentals } from "@/lib/providers/yahoo";

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
