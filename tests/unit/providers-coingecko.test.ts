import { describe, expect, it } from "vitest";

import {
  coingeckoSchemas,
  computeVolatility,
  getCryptoFundamentals,
  getTopCryptos,
  mapCoinGecko,
} from "@/lib/providers/coingecko";

describe("computeVolatility", () => {
  it("returns null for insufficient data", () => {
    expect(computeVolatility([[0, 1]])).toBeNull();
  });
  it("returns a positive number for a varying series", () => {
    const prices: Array<[number, number]> = [
      [0, 100],
      [1, 102],
      [2, 99],
      [3, 105],
      [4, 101],
    ];
    const vol = computeVolatility(prices);
    expect(vol).not.toBeNull();
    expect(vol).toBeGreaterThan(0);
  });
});

describe("mapCoinGecko", () => {
  it("computes the NVT ratio from market cap and volume", () => {
    const market = {
      id: "bitcoin",
      symbol: "btc",
      name: "Bitcoin",
      current_price: 50000,
      market_cap: 1e12,
      market_cap_rank: 1,
      fully_diluted_valuation: 1.1e12,
      total_volume: 2e10,
      circulating_supply: 19e6,
      total_supply: 21e6,
      price_change_percentage_24h: 1.5,
      price_change_percentage_30d_in_currency: 8,
    };
    const f = mapCoinGecko("btc", market, 40);
    expect(f.symbol).toBe("BTC");
    expect(f.nvtRatio).toBe(50);
    expect(f.volatility30d).toBe(40);
  });
});

describe("coingecko schemas", () => {
  it("validates market chart tuples", () => {
    const good = { prices: [[1, 2]] };
    const bad = { prices: [[1]] };
    expect(coingeckoSchemas.MarketChartSchema.safeParse(good).success).toBe(
      true,
    );
    expect(coingeckoSchemas.MarketChartSchema.safeParse(bad).success).toBe(
      false,
    );
  });
});

describe("getCryptoFundamentals", () => {
  it("returns NOT_FOUND for unsupported coins", async () => {
    const result = await getCryptoFundamentals("DOGE");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
  it("falls back to fixtures for supported coins without a key", async () => {
    const result = await getCryptoFundamentals("BTC");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.symbol).toBe("BTC");
  });
});

describe("getTopCryptos", () => {
  it("returns the hardcoded fallback without a key", async () => {
    const top = await getTopCryptos();
    expect(top).toHaveLength(5);
    expect(top[0]?.type).toBe("crypto");
  });
});
