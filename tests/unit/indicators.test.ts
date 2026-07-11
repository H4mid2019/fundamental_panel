import { describe, expect, it } from "vitest";

import { buildCryptoIndicators } from "@/lib/indicators/crypto";
import {
  getDefinition,
  INDICATOR_DEFINITIONS,
} from "@/lib/indicators/definitions";
import { buildStockIndicators, computePegy } from "@/lib/indicators/stock";
import type { CryptoFundamentals, StockFundamentals } from "@/lib/types";

const stock: StockFundamentals = {
  symbol: "TST",
  name: "Test Co",
  price: 100,
  currency: "USD",
  changePct: 1,
  sector: "Tech",
  marketCap: 1e12,
  beta: 1.1,
  peRatio: 12,
  pbRatio: 1.2,
  psRatio: 1.5,
  pegRatio: 0.9,
  evToEbitda: 9,
  dividendYield: 3.5,
  payoutRatio: 40,
  eps: 5,
  roe: 25,
  roa: 12,
  netProfitMargin: 22,
  currentRatio: 2,
  quickRatio: 1.5,
  debtToEquity: 0.3,
  interestCoverage: 12,
  freeCashFlow: 5e9,
  revenueGrowthYoY: 15,
  assetTurnover: 1.2,
};

const crypto: CryptoFundamentals = {
  symbol: "BTC",
  name: "Bitcoin",
  price: 50000,
  currency: "USD",
  changePct: 2,
  rank: 1,
  marketCap: 1e12,
  fullyDilutedValuation: 1.1e12,
  totalVolume: 3e10,
  circulatingSupply: 19e6,
  totalSupply: 21e6,
  volatility30d: 35,
  nvtRatio: 25,
  priceChange30dPct: 5,
};

describe("definitions", () => {
  it("has metadata for every id and getDefinition returns it", () => {
    for (const [id, def] of Object.entries(INDICATOR_DEFINITIONS)) {
      expect(def.id).toBe(id);
      expect(getDefinition(def.id)).toBe(def);
    }
  });
});

describe("computePegy", () => {
  it("divides P/E by growth plus dividend yield", () => {
    // growth = P/E ÷ PEG = 12 / 0.9 = 13.33%; PEGY = 12 / (13.33 + 3.5) = 0.71
    expect(computePegy(stock)).toBeCloseTo(0.71, 2);
  });

  it("is lower than PEG whenever a dividend is paid", () => {
    // The yield only ever enlarges the denominator, so PEGY <= PEG.
    const pegy = computePegy(stock);
    expect(pegy).not.toBeNull();
    expect(pegy ?? 0).toBeLessThan(stock.pegRatio ?? 0);
  });

  it("equals PEG when the company pays no dividend", () => {
    const noDiv = { ...stock, dividendYield: 0 };
    expect(computePegy(noDiv)).toBeCloseTo(stock.pegRatio ?? 0, 2);
  });

  it("returns null when any input is missing", () => {
    expect(computePegy({ ...stock, peRatio: null })).toBeNull();
    expect(computePegy({ ...stock, pegRatio: null })).toBeNull();
    expect(computePegy({ ...stock, dividendYield: null })).toBeNull();
  });

  it("returns null for a loss-making or degenerate P/E and PEG", () => {
    expect(computePegy({ ...stock, peRatio: -8 })).toBeNull();
    expect(computePegy({ ...stock, peRatio: 0 })).toBeNull();
    expect(computePegy({ ...stock, pegRatio: 0 })).toBeNull();
  });

  it("returns null when shrinking earnings outweigh the yield", () => {
    // Negative PEG => negative growth; growth + yield <= 0 is not meaningful.
    const shrinking = { ...stock, peRatio: 20, pegRatio: -1, dividendYield: 1 };
    expect(computePegy(shrinking)).toBeNull();
  });
});

describe("buildStockIndicators", () => {
  it("produces 21 indicators with resolved sentiment", () => {
    const indicators = buildStockIndicators(stock);
    expect(indicators).toHaveLength(21);
    const pe = indicators.find((i) => i.id === "pe");
    expect(pe?.value).toBe(12);
    expect(pe?.sentiment).toBe("bullish");
    expect(pe?.sectorAverage).toBe(22);
  });

  it("marks null fundamentals as unknown", () => {
    const sparse = { ...stock, peRatio: null };
    const pe = buildStockIndicators(sparse).find((i) => i.id === "pe");
    expect(pe?.value).toBeNull();
    expect(pe?.sentiment).toBe("unknown");
  });
});

describe("buildCryptoIndicators", () => {
  it("produces the three universal crypto indicators", () => {
    const indicators = buildCryptoIndicators(crypto);
    expect(indicators.map((i) => i.id)).toEqual([
      "marketCap",
      "volatility30d",
      "nvtRatio",
    ]);
    expect(indicators.find((i) => i.id === "volatility30d")?.sentiment).toBe(
      "bullish",
    );
  });
});
