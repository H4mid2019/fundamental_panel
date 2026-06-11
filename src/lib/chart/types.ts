/**
 * Domain types for the TradingView-style chart route.
 *
 * Candle times are UNIX seconds (UTC) to match `lightweight-charts`'
 * `UTCTimestamp`. These types are hand-written; the Zod schemas that validate
 * raw provider payloads live in `src/lib/providers/candles.ts`.
 */

/** Upstream market-data sources for candles. */
export type CandleSource = "binance" | "hyperliquid" | "yahoo";

/** Unified, source-agnostic interval set offered in the UI. */
export const CHART_INTERVALS = [
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1d",
  "1wk",
] as const;

/** A chart timeframe (mapped per source by the candles provider). */
export type ChartInterval = (typeof CHART_INTERVALS)[number];

/** A single OHLCV bar. */
export interface Candle {
  /** Bar open time in UNIX seconds (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Base-asset volume, or null when the source omits it. */
  volume: number | null;
  /**
   * Taker buy (aggressor) base volume for the bar, when available (Binance).
   * Enables order-flow indicators (CVD/OFI/VPIN) without a separate trade feed.
   */
  buyVolume?: number | null;
}

/** A resolved candle series for one leg/symbol. */
export interface CandleSeriesPayload {
  source: CandleSource;
  /** The provider-native symbol that was fetched (e.g. `BTCUSDT`, `^GSPC`). */
  symbol: string;
  interval: ChartInterval;
  candles: Candle[];
  /** True when served from deterministic fixtures (offline/upstream failure). */
  fallback: boolean;
  asOf: string;
}
