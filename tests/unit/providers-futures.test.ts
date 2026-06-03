import { afterEach, describe, expect, it, vi } from "vitest";

const { quoteMock } = vi.hoisted(() => ({ quoteMock: vi.fn() }));

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    quote = quoteMock;
    options = vi.fn();
  },
}));

import { getFuturesQuotes } from "@/lib/providers/yahoo";

afterEach(() => vi.clearAllMocks());

describe("getFuturesQuotes", () => {
  it("overlays live quotes onto the fixture watchlist", async () => {
    quoteMock.mockResolvedValue([
      {
        symbol: "CL=F",
        shortName: "Crude Oil Live",
        regularMarketPrice: 80,
        regularMarketChangePercent: 1.5,
        currency: "USD",
      },
    ]);
    const result = await getFuturesQuotes();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const cl = result.data.find((q) => q.symbol === "CL=F");
      expect(cl?.price).toBe(80);
      expect(cl?.name).toBe("Crude Oil Live");
      // Other symbols retain fixture values.
      expect(
        result.data.find((q) => q.symbol === "GC=F")?.price,
      ).not.toBeNull();
    }
  });

  it("returns the fixture watchlist when Yahoo fails", async () => {
    quoteMock.mockRejectedValue(new Error("offline"));
    const result = await getFuturesQuotes();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.length).toBeGreaterThan(0);
  });
});
