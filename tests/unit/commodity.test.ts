import { describe, expect, it } from "vitest";

import { resolveAssetType, resolveCommodityCategory } from "@/lib/assets";
import type { Candle } from "@/lib/chart/types";
import { buildCommodityIndicators } from "@/lib/indicators/commodity";
import {
  annualizedVolatility,
  computePriceAction,
} from "@/lib/indicators/priceAction";
import { classify } from "@/lib/indicators/thresholds";
import type { CommodityFundamentals } from "@/lib/types";

/** Daily candles from a list of closes (flat OHLC unless a range is given). */
function daily(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 86_400,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

describe("resolveAssetType", () => {
  it("classifies Yahoo futures symbols as commodities", () => {
    expect(resolveAssetType("GC=F")).toBe("commodity");
    expect(resolveAssetType("cl=f")).toBe("commodity");
    expect(resolveAssetType("SI=F")).toBe("commodity");
  });

  it("still classifies stocks, indexes and crypto correctly", () => {
    expect(resolveAssetType("AAPL")).toBe("stock");
    expect(resolveAssetType("^GSPC")).toBe("index");
    expect(resolveAssetType("BTC")).toBe("crypto");
  });
});

describe("resolveCommodityCategory", () => {
  it("returns the curated category", () => {
    expect(resolveCommodityCategory("GC=F")).toBe("Precious metal");
    expect(resolveCommodityCategory("CL=F")).toBe("Energy");
    expect(resolveCommodityCategory("ZC=F")).toBe("Agriculture");
  });

  it("returns null for a non-commodity", () => {
    expect(resolveCommodityCategory("AAPL")).toBeNull();
  });
});

describe("annualizedVolatility", () => {
  it("is zero for a perfectly flat series", () => {
    expect(annualizedVolatility(daily(Array(60).fill(100)), 30)).toBe(0);
  });

  it("returns null without enough bars", () => {
    expect(annualizedVolatility(daily([100, 101, 102]), 30)).toBeNull();
  });

  it("grows with the size of the daily swings", () => {
    const calm = daily(Array.from({ length: 60 }, (_, i) => 100 + (i % 2)));
    const wild = daily(
      Array.from({ length: 60 }, (_, i) => 100 + (i % 2) * 10),
    );
    const calmVol = annualizedVolatility(calm, 30) ?? 0;
    const wildVol = annualizedVolatility(wild, 30) ?? 0;
    expect(wildVol).toBeGreaterThan(calmVol);
  });
});

describe("computePriceAction", () => {
  it("derives trend, 52-week range position and RSI", () => {
    // 300 sessions rising steadily from 100 to ~160.
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.2);
    const action = computePriceAction(daily(closes));

    // A steady uptrend sits above its 200-day average.
    expect(action.trendVs200d).not.toBeNull();
    expect(action.trendVs200d ?? 0).toBeGreaterThan(0);
    // Rising into the last bar means we're at the 52-week high.
    expect(action.from52wHigh).toBeCloseTo(0, 1);
    // ...and well above the 52-week low.
    expect(action.from52wLow ?? 0).toBeGreaterThan(0);
    // Monotonic gains pin RSI at 100.
    expect(action.rsi14).toBeCloseTo(100, 0);
    expect(action.volatility30d).not.toBeNull();
    expect(action.volatility90d).not.toBeNull();
  });

  it("reports a negative trend and a drawdown for a falling market", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 200 - i * 0.3);
    const action = computePriceAction(daily(closes));
    expect(action.trendVs200d ?? 0).toBeLessThan(0);
    expect(action.from52wHigh ?? 0).toBeLessThan(0); // below the high
    expect(action.from52wLow).toBeCloseTo(0, 1); // sitting on the low
  });

  it("degrades to nulls when there is too little history", () => {
    const action = computePriceAction(daily([100, 101]));
    expect(action.trendVs200d).toBeNull();
    expect(action.volatility30d).toBeNull();
    expect(action.rsi14).toBeNull();
  });
});

describe("commodity thresholds", () => {
  it("uses commodity volatility bands, not the crypto ones", () => {
    // 30% annualized vol is calm for crypto but hot for gold. The shared rule
    // (bullish <= 40) would call it bullish; the commodity override must not.
    expect(classify("volatility30d", 30, "crypto")).toBe("bullish");
    expect(classify("volatility30d", 30, "commodity")).toBe("neutral");
    expect(classify("volatility30d", 45, "commodity")).toBe("bearish");
    expect(classify("volatility30d", 12, "commodity")).toBe("bullish");
  });

  it("falls back to the shared rule when no override exists", () => {
    expect(classify("rsi14", 50, "commodity")).toBe("bullish");
    expect(classify("rsi14", 50)).toBe("bullish");
  });

  it("treats RSI extremes at both ends as exhaustion risk", () => {
    expect(classify("rsi14", 85)).toBe("bearish");
    expect(classify("rsi14", 15)).toBe("bearish");
    expect(classify("rsi14", 75)).toBe("neutral");
  });

  it("reads pressing the highs as strength and a deep drawdown as weakness", () => {
    expect(classify("from52wHigh", -2)).toBe("bullish");
    expect(classify("from52wHigh", -30)).toBe("bearish");
  });

  it("leaves distance from the 52-week low unjudged (context, not signal)", () => {
    expect(classify("from52wLow", 5)).toBe("neutral");
    expect(classify("from52wLow", 80)).toBe("neutral");
  });
});

describe("buildCommodityIndicators", () => {
  const gold: CommodityFundamentals = {
    symbol: "GC=F",
    name: "Gold",
    price: 4208,
    currency: "USD",
    changePct: 0.8,
    category: "Precious metal",
    volatility30d: 14.2,
    volatility90d: 16.1,
    trendVs200d: 8.4,
    from52wHigh: -3.1,
    from52wLow: 41.2,
    rsi14: 61.3,
  };

  it("produces the six price-action indicators, not empty fundamentals", () => {
    const indicators = buildCommodityIndicators(gold);
    expect(indicators).toHaveLength(6);
    expect(indicators.map((i) => i.id)).toEqual([
      "trendVs200d",
      "rsi14",
      "from52wHigh",
      "from52wLow",
      "volatility30d",
      "volatility90d",
    ]);
    // Every card carries a value — no wall of N/A.
    expect(indicators.every((i) => i.value !== null)).toBe(true);
  });

  it("classifies an uptrending, low-volatility gold correctly", () => {
    const by = new Map(buildCommodityIndicators(gold).map((i) => [i.id, i]));
    expect(by.get("trendVs200d")?.sentiment).toBe("bullish"); // +8.4% >= 3
    expect(by.get("volatility30d")?.sentiment).toBe("bullish"); // 14.2% <= 18
    expect(by.get("from52wHigh")?.sentiment).toBe("bullish"); // -3.1% >= -5
    expect(by.get("rsi14")?.sentiment).toBe("bullish"); // 61 in [30, 70]
  });

  it("carries nulls through as unknown rather than inventing a value", () => {
    const sparse = { ...gold, trendVs200d: null, rsi14: null };
    const by = new Map(buildCommodityIndicators(sparse).map((i) => [i.id, i]));
    expect(by.get("trendVs200d")?.sentiment).toBe("unknown");
    expect(by.get("rsi14")?.sentiment).toBe("unknown");
  });
});
