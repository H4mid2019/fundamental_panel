import { describe, expect, it } from "vitest";

import {
  assetFromSymbol,
  CHART_ASSETS,
  DEFAULT_CHART_ASSET,
  findChartAsset,
  INTERVAL_SECONDS,
  providerInterval,
  yahooLookbackDays,
  yahooNeedsAggregation,
} from "@/lib/chart/symbols";
import { CHART_INTERVALS } from "@/lib/chart/types";

describe("findChartAsset", () => {
  it("resolves a curated asset case-insensitively", () => {
    expect(findChartAsset("btc")?.providerSymbol).toBe("BTCUSDT");
    expect(findChartAsset("GOLD")?.providerSymbol).toBe("GC=F");
  });

  it("returns undefined for an unknown id", () => {
    expect(findChartAsset("NOPE")).toBeUndefined();
  });
});

describe("assetFromSymbol", () => {
  it("returns the curated asset when present", () => {
    expect(assetFromSymbol("BTC")).toBe(DEFAULT_CHART_ASSET);
  });

  it("treats a caret-prefixed symbol as a Yahoo index", () => {
    const a = assetFromSymbol("^FTSE");
    expect(a.source).toBe("yahoo");
    expect(a.kind).toBe("index");
    expect(a.providerSymbol).toBe("^FTSE");
  });

  it("falls back to a Yahoo equity for an unknown ticker", () => {
    const a = assetFromSymbol("nvda", "NVIDIA");
    expect(a.source).toBe("yahoo");
    expect(a.kind).toBe("stock");
    expect(a.id).toBe("NVDA");
    expect(a.label).toBe("NVIDIA");
  });
});

describe("providerInterval", () => {
  it("maps unified intervals to Binance codes", () => {
    expect(providerInterval("binance", "1wk")).toBe("1w");
    expect(providerInterval("binance", "4h")).toBe("4h");
  });

  it("maps 1h to Yahoo's 60m and 4h (aggregated) to 60m", () => {
    expect(providerInterval("yahoo", "1h")).toBe("60m");
    expect(providerInterval("yahoo", "4h")).toBe("60m");
    expect(providerInterval("yahoo", "1wk")).toBe("1wk");
  });
});

describe("yahooNeedsAggregation", () => {
  it("is true only for 4h", () => {
    expect(yahooNeedsAggregation("4h")).toBe(true);
    expect(yahooNeedsAggregation("1h")).toBe(false);
    expect(yahooNeedsAggregation("1d")).toBe(false);
  });
});

describe("interval tables", () => {
  it("define seconds and a Yahoo lookback for every interval", () => {
    for (const iv of CHART_INTERVALS) {
      expect(INTERVAL_SECONDS[iv]).toBeGreaterThan(0);
      expect(yahooLookbackDays(iv)).toBeGreaterThan(0);
    }
  });
});

describe("CHART_ASSETS", () => {
  it("includes the assets needed for the documented pairs", () => {
    const ids = new Set(CHART_ASSETS.map((a) => a.id));
    for (const id of ["BTC", "ETH", "SPX", "GOLD", "OIL"]) {
      expect(ids.has(id)).toBe(true);
    }
  });
});
