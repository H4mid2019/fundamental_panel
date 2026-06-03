import { afterEach, describe, expect, it, vi } from "vitest";

const { chartMock } = vi.hoisted(() => ({ chartMock: vi.fn() }));

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    chart = chartMock;
    quote = vi.fn();
    options = vi.fn();
  },
}));

import { getPerformance } from "@/lib/providers/performance";

afterEach(() => vi.clearAllMocks());

describe("getPerformance", () => {
  it("maps a live Yahoo chart into trailing returns", async () => {
    const now = Date.now();
    chartMock.mockResolvedValue({
      meta: { regularMarketPrice: 120 },
      quotes: [
        { date: new Date(now - 365 * 86_400_000), close: 100 },
        { date: new Date(now), close: 120 },
      ],
    });
    const result = await getPerformance("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fallback).toBe(false);
      expect(result.data.oneY).toBeCloseTo(20, 0);
    }
  });

  it("falls back to fixture returns when Yahoo fails", async () => {
    chartMock.mockRejectedValue(new Error("offline"));
    const result = await getPerformance("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.fallback).toBe(true);
  });
});
