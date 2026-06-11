/**
 * Registry of chartable assets and the per-source interval/lookback mappings.
 *
 * The chart route lets a user build any pair (numerator / denominator) from
 * these assets — e.g. "S&P 500 / Gold", "BTC / Gold", "ETH / BTC" — as well as
 * plain single-asset series. Stocks not in the registry resolve to Yahoo
 * ad-hoc via {@link assetFromSymbol}.
 */

import type { CandleSource, ChartInterval } from "./types";

/** Broad asset class, used for grouping and default styling. */
export type ChartAssetKind = "crypto" | "index" | "future" | "fx" | "stock";

/** A chartable instrument resolved to a concrete data source. */
export interface ChartAsset {
  /** Stable, app-native id (e.g. `BTC`, `SPX`, `GOLD`, `AAPL`). */
  id: string;
  /** Human label shown in pickers (e.g. `S&P 500`, `Gold`). */
  label: string;
  kind: ChartAssetKind;
  /** Primary data source. */
  source: CandleSource;
  /** Provider-native symbol (e.g. `BTCUSDT`, `^GSPC`, `GC=F`). */
  providerSymbol: string;
  /** Quote currency/unit for the ratio label (defaults to `USD`). */
  quote?: string;
}

/** The default primary asset (guaranteed present, avoids non-null assertions). */
export const DEFAULT_CHART_ASSET: ChartAsset = {
  id: "BTC",
  label: "Bitcoin",
  kind: "crypto",
  source: "binance",
  providerSymbol: "BTCUSDT",
};

/** Curated, ready-to-chart instruments. Crypto defaults to Binance spot. */
export const CHART_ASSETS: readonly ChartAsset[] = [
  // Crypto (Binance spot; Hyperliquid is the server-side fallback)
  DEFAULT_CHART_ASSET,
  {
    id: "ETH",
    label: "Ethereum",
    kind: "crypto",
    source: "binance",
    providerSymbol: "ETHUSDT",
  },
  {
    id: "SOL",
    label: "Solana",
    kind: "crypto",
    source: "binance",
    providerSymbol: "SOLUSDT",
  },
  {
    id: "BNB",
    label: "BNB",
    kind: "crypto",
    source: "binance",
    providerSymbol: "BNBUSDT",
  },
  {
    id: "XRP",
    label: "XRP",
    kind: "crypto",
    source: "binance",
    providerSymbol: "XRPUSDT",
  },
  // Indexes
  {
    id: "SPX",
    label: "S&P 500",
    kind: "index",
    source: "yahoo",
    providerSymbol: "^GSPC",
  },
  {
    id: "NDX",
    label: "Nasdaq 100",
    kind: "index",
    source: "yahoo",
    providerSymbol: "^NDX",
  },
  {
    id: "DJI",
    label: "Dow Jones",
    kind: "index",
    source: "yahoo",
    providerSymbol: "^DJI",
  },
  {
    id: "VIX",
    label: "VIX",
    kind: "index",
    source: "yahoo",
    providerSymbol: "^VIX",
  },
  // Futures / commodities
  {
    id: "GOLD",
    label: "Gold",
    kind: "future",
    source: "yahoo",
    providerSymbol: "GC=F",
  },
  {
    id: "SILVER",
    label: "Silver",
    kind: "future",
    source: "yahoo",
    providerSymbol: "SI=F",
  },
  {
    id: "OIL",
    label: "Crude Oil (WTI)",
    kind: "future",
    source: "yahoo",
    providerSymbol: "CL=F",
  },
  {
    id: "NATGAS",
    label: "Natural Gas",
    kind: "future",
    source: "yahoo",
    providerSymbol: "NG=F",
  },
  {
    id: "COPPER",
    label: "Copper",
    kind: "future",
    source: "yahoo",
    providerSymbol: "HG=F",
  },
  // FX
  {
    id: "DXY",
    label: "US Dollar Index",
    kind: "fx",
    source: "yahoo",
    providerSymbol: "DX-Y.NYB",
  },
  {
    id: "EURUSD",
    label: "EUR/USD",
    kind: "fx",
    source: "yahoo",
    providerSymbol: "EURUSD=X",
  },
] as const;

/** Look up a curated asset by its app-native id (case-insensitive). */
export function findChartAsset(id: string): ChartAsset | undefined {
  const key = id.trim().toUpperCase();
  return CHART_ASSETS.find((a) => a.id.toUpperCase() === key);
}

/**
 * Resolve a raw symbol to a {@link ChartAsset}, falling back to an ad-hoc Yahoo
 * equity so searched tickers (e.g. `NVDA`) are chartable without a registry
 * entry.
 *
 * @param symbol - App id or provider symbol.
 * @param label - Optional display label.
 * @returns The resolved asset.
 */
export function assetFromSymbol(symbol: string, label?: string): ChartAsset {
  const found = findChartAsset(symbol);
  if (found) return found;
  const upper = symbol.trim().toUpperCase();
  return {
    id: upper,
    label: label ?? upper,
    kind: upper.startsWith("^") ? "index" : "stock",
    source: "yahoo",
    providerSymbol: upper,
  };
}

/** Per-source mapping of the unified interval to the provider's interval code. */
const SOURCE_INTERVALS: Record<
  CandleSource,
  Partial<Record<ChartInterval, string>>
> = {
  binance: {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
    "1wk": "1w",
  },
  hyperliquid: {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
    "1wk": "1w",
  },
  // Yahoo has no native 4h; the provider fetches 1h and aggregates 4×.
  yahoo: {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "60m",
    "4h": "60m",
    "1d": "1d",
    "1wk": "1wk",
  },
};

/**
 * Map a unified interval to a provider interval code.
 *
 * @returns The provider code, or `null` when the source can't serve it.
 */
export function providerInterval(
  source: CandleSource,
  interval: ChartInterval,
): string | null {
  return SOURCE_INTERVALS[source][interval] ?? null;
}

/** Whether Yahoo must aggregate 1h bars to satisfy this interval (4h). */
export function yahooNeedsAggregation(interval: ChartInterval): boolean {
  return interval === "4h";
}

/** Approximate seconds per bar, used to bound REST requests. */
export const INTERVAL_SECONDS: Record<ChartInterval, number> = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
  "1wk": 7 * 24 * 60 * 60,
};

/** Lookback window (days) for Yahoo `chart()` requests per interval. */
export function yahooLookbackDays(interval: ChartInterval): number {
  switch (interval) {
    case "1m":
      return 6; // Yahoo caps 1m history at ~7 days
    case "5m":
      return 30;
    case "15m":
      return 45;
    case "1h":
      return 180;
    case "4h":
      return 365; // aggregated from 1h
    case "1d":
      return 365 * 4;
    case "1wk":
      return 365 * 10;
  }
}
