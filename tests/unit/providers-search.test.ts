import { afterEach, describe, expect, it, vi } from "vitest";

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    search = searchMock;
    quote = vi.fn();
    options = vi.fn();
    chart = vi.fn();
  },
}));

import { getSymbolSearch } from "@/lib/providers/yahoo";

afterEach(() => vi.clearAllMocks());

describe("getSymbolSearch", () => {
  it("returns [] for an empty query", async () => {
    expect(await getSymbolSearch("  ")).toEqual([]);
  });

  it("maps Yahoo equity/index results and skips other types", async () => {
    searchMock.mockResolvedValue({
      quotes: [
        { symbol: "MU", shortname: "Micron Technology", quoteType: "EQUITY" },
        { symbol: "^GSPC", shortname: "S&P 500", quoteType: "INDEX" },
        { symbol: "EURUSD=X", shortname: "EUR/USD", quoteType: "CURRENCY" },
      ],
    });
    const results = await getSymbolSearch("micron");
    const symbols = results.map((r) => r.symbol);
    expect(symbols).toContain("MU");
    expect(symbols).toContain("^GSPC");
    expect(symbols).not.toContain("EURUSD=X");
    expect(results.find((r) => r.symbol === "MU")?.type).toBe("stock");
  });

  it("falls back to the curated list when Yahoo search fails", async () => {
    searchMock.mockRejectedValue(new Error("offline"));
    const results = await getSymbolSearch("apple");
    expect(results.some((r) => r.symbol === "AAPL")).toBe(true);
  });
});
