import { describe, expect, it, vi } from "vitest";

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    quote = vi.fn().mockRejectedValue(new Error("offline"));
    quoteSummary = vi.fn().mockRejectedValue(new Error("offline"));
    recommendationsBySymbol = vi.fn().mockRejectedValue(new Error("offline"));
    fundamentalsTimeSeries = vi.fn().mockRejectedValue(new Error("offline"));
  },
}));

import { getStockFixture } from "@/lib/fixtures";
import {
  deriveValuationRatios,
  getAssetSnapshot,
  getFinancials,
  getIndicatorSet,
  getPeerBenchmarks,
} from "@/lib/service";

describe("getAssetSnapshot", () => {
  it("builds a stock snapshot from fixtures", async () => {
    const result = await getAssetSnapshot("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe("stock");
      expect(result.data.symbol).toBe("AAPL");
      expect(result.data.meta).toBe("Technology");
    }
  });

  it("builds a crypto snapshot with rank metadata", async () => {
    const result = await getAssetSnapshot("BTC");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe("crypto");
      expect(result.data.meta).toContain("Rank");
    }
  });

  it("builds an index snapshot (yahoo offline → fixture)", async () => {
    const result = await getAssetSnapshot("^GSPC");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.type).toBe("index");
  });
});

describe("getIndicatorSet", () => {
  it("returns 21 indicators for a stock", async () => {
    const result = await getIndicatorSet("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.indicators).toHaveLength(21);
  });

  it("returns the universal indicators for crypto", async () => {
    const result = await getIndicatorSet("ETH");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assetType).toBe("crypto");
      expect(result.data.indicators).toHaveLength(3);
    }
  });
});

describe("deriveValuationRatios", () => {
  it("derives a negative P/E from price and negative EPS", () => {
    const base = {
      ...getStockFixture("AAPL"),
      peRatio: null,
      price: 108.23,
      eps: -0.32,
    };
    expect(deriveValuationRatios(base).peRatio).toBeCloseTo(-338.22, 2);
  });

  it("leaves an existing P/E untouched", () => {
    const base = { ...getStockFixture("AAPL"), peRatio: 32.4, eps: -0.32 };
    expect(deriveValuationRatios(base).peRatio).toBe(32.4);
  });

  it("keeps P/E null when price or EPS is missing or zero", () => {
    const fixture = getStockFixture("AAPL");
    expect(
      deriveValuationRatios({ ...fixture, peRatio: null, eps: null }).peRatio,
    ).toBeNull();
    expect(
      deriveValuationRatios({ ...fixture, peRatio: null, eps: 0 }).peRatio,
    ).toBeNull();
    expect(
      deriveValuationRatios({ ...fixture, peRatio: null, price: null }).peRatio,
    ).toBeNull();
  });
});

describe("getPeerBenchmarks", () => {
  it("rejects non-stock assets", async () => {
    const result = await getPeerBenchmarks("BTC");
    expect(result.ok).toBe(false);
  });

  it("degrades to a fallback payload when peers are unavailable", async () => {
    const result = await getPeerBenchmarks("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.symbol).toBe("AAPL");
      expect(result.data.fallback).toBe(true);
      expect(result.data.groups.map((g) => g.id)).toEqual([
        "quote",
        "value",
        "size",
        "growth",
        "profit",
      ]);
    }
  });
});

describe("getFinancials", () => {
  it("rejects non-stock assets", async () => {
    const result = await getFinancials("^GSPC", "annual");
    expect(result.ok).toBe(false);
  });

  it("errors when no statement data is available (yahoo offline)", async () => {
    const result = await getFinancials("AAPL", "annual");
    expect(result.ok).toBe(false);
  });
});
