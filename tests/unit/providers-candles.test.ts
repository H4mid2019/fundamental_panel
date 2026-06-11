import { describe, expect, it, vi } from "vitest";

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    chart = vi.fn();
  },
}));

// Force the fixture path so getCandles is hermetic.
vi.mock("@/lib/env", () => ({
  env: { NODE_ENV: "test" },
  features: { forceFixtures: true },
}));

import {
  aggregateCandles,
  getCandles,
  hyperliquidCoin,
} from "@/lib/providers/candles";
import type { Candle } from "@/lib/chart/types";

function bar(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c, volume: 10 };
}

describe("hyperliquidCoin", () => {
  it("strips quote suffixes from a Binance pair", () => {
    expect(hyperliquidCoin("BTCUSDT")).toBe("BTC");
    expect(hyperliquidCoin("ETHUSDC")).toBe("ETH");
    expect(hyperliquidCoin("SOLUSD")).toBe("SOL");
  });
});

describe("aggregateCandles", () => {
  it("merges 4 bars into one OHLCV bar", () => {
    const src = [
      bar(0, 10, 12, 9, 11),
      bar(60, 11, 15, 10, 14),
      bar(120, 14, 14, 8, 9),
      bar(180, 9, 11, 7, 10),
    ];
    const [agg] = aggregateCandles(src, 4);
    expect(agg?.time).toBe(0);
    expect(agg?.open).toBe(10); // first open
    expect(agg?.close).toBe(10); // last close
    expect(agg?.high).toBe(15); // max high
    expect(agg?.low).toBe(7); // min low
    expect(agg?.volume).toBe(40); // summed
  });

  it("returns the input unchanged for factor <= 1", () => {
    const src = [bar(0, 1, 1, 1, 1)];
    expect(aggregateCandles(src, 1)).toBe(src);
  });
});

describe("getCandles (fixture mode)", () => {
  it("returns deterministic fallback candles", async () => {
    const a = await getCandles("binance", "BTCUSDT", "1h", 50);
    const b = await getCandles("binance", "BTCUSDT", "1h", 50);
    expect(a.fallback).toBe(true);
    expect(a.candles).toHaveLength(50);
    // Deterministic: identical across calls.
    expect(a.candles[0]?.close).toBe(b.candles[0]?.close);
    // Ascending, unique times.
    for (let i = 1; i < a.candles.length; i += 1) {
      expect((a.candles[i]?.time ?? 0) > (a.candles[i - 1]?.time ?? 0)).toBe(
        true,
      );
    }
  });

  it("includes taker-buy volume for order-flow studies", async () => {
    const res = await getCandles("binance", "ETHUSDT", "5m", 20);
    expect(res.candles[0]?.buyVolume).toBeTypeOf("number");
  });
});
