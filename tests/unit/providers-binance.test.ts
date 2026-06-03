import { afterEach, describe, expect, it, vi } from "vitest";

import { computeOrderBook, getOrderBook } from "@/lib/providers/binance";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("computeOrderBook", () => {
  it("computes mid, spread and imbalance", () => {
    const ob = computeOrderBook(
      "btc",
      [
        { price: 100, quantity: 2 },
        { price: 99, quantity: 1 },
      ],
      [
        { price: 101, quantity: 1 },
        { price: 102, quantity: 1 },
      ],
      0,
      false,
    );
    expect(ob.midPrice).toBe(100.5);
    expect(ob.spread).toBe(1);
    expect(ob.imbalance).toBeCloseTo(0.2, 5);
    expect(ob.symbol).toBe("BTC");
  });
});

describe("getOrderBook", () => {
  it("maps a live Binance depth response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            bids: [["100.0", "2.0"]],
            asks: [["101.0", "1.0"]],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await getOrderBook("BTC");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fallback).toBe(false);
      expect(result.data.bids[0]?.price).toBe(100);
    }
  });

  it("falls back to a fixture book when Binance fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await getOrderBook("BTC");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fallback).toBe(true);
      expect(result.data.bids.length).toBeGreaterThan(0);
    }
  });
});
