import { afterEach, describe, expect, it, vi } from "vitest";

const { optionsMock } = vi.hoisted(() => ({ optionsMock: vi.fn() }));

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    options = optionsMock;
    quote = vi.fn();
  },
}));

import { getOptionsChain } from "@/lib/providers/options";

afterEach(() => vi.clearAllMocks());

describe("getOptionsChain", () => {
  it("returns NOT_FOUND for crypto", async () => {
    const result = await getOptionsChain("BTC");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("maps a live Yahoo options result", async () => {
    optionsMock.mockResolvedValue({
      expirationDates: [new Date("2025-01-17"), new Date("2025-02-21")],
      quote: { regularMarketPrice: 200 },
      options: [
        {
          expirationDate: new Date("2025-01-17"),
          calls: [
            {
              strike: 195,
              lastPrice: 8,
              impliedVolatility: 0.3,
              openInterest: 100,
              inTheMoney: true,
            },
            {
              strike: 205,
              lastPrice: 3,
              impliedVolatility: 0.35,
              openInterest: 50,
              inTheMoney: false,
            },
          ],
          puts: [
            {
              strike: 195,
              lastPrice: 2,
              impliedVolatility: 0.31,
              openInterest: 80,
              inTheMoney: false,
            },
            {
              strike: 205,
              lastPrice: 7,
              impliedVolatility: 0.36,
              openInterest: 120,
              inTheMoney: true,
            },
          ],
        },
      ],
    });
    const result = await getOptionsChain("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fallback).toBe(false);
      expect(result.data.underlyingPrice).toBe(200);
      expect(result.data.calls).toHaveLength(2);
      expect(result.data.putCallRatio).toBeCloseTo(200 / 150, 2);
      expect(result.data.expirations).toContain("2025-01-17");
    }
  });

  it("falls back to a fixture chain when Yahoo fails", async () => {
    optionsMock.mockRejectedValue(new Error("offline"));
    const result = await getOptionsChain("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fallback).toBe(true);
      expect(result.data.calls.length).toBeGreaterThan(0);
      expect(result.data.expirations.length).toBeGreaterThan(0);
    }
  });
});
