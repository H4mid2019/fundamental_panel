/**
 * UI-facing chart model shared by the page, hooks and the chart component.
 *
 * A *series* is one plotted instrument: either a single asset (e.g. `BTC`) or a
 * ratio pair (numerator / denominator, e.g. `BTC / GOLD`). The first series is
 * the *primary* and drives candlesticks and indicator studies; the rest overlay
 * as lines.
 */

import type { ChartAsset } from "./symbols";
import type { Candle } from "./types";

/** Palette for series lines (primary uses candlesticks, not this color). */
export const SERIES_COLORS = [
  "#2962ff",
  "#ff6d00",
  "#26a69a",
  "#ab47bc",
] as const;

/** A user-defined series: a single asset or a ratio pair. */
export interface ChartSeriesSpec {
  id: string;
  numerator: ChartAsset;
  /** Denominator for a ratio pair, or `null` for a single asset. */
  denominator: ChartAsset | null;
  color: string;
  visible: boolean;
}

/** A series after its candles are fetched/derived. */
export interface ResolvedSeries {
  id: string;
  label: string;
  color: string;
  isRatio: boolean;
  visible: boolean;
  candles: Candle[];
  isLoading: boolean;
  isError: boolean;
  fallback: boolean;
  /** Last close (for the legend). */
  lastValue: number | null;
}

/** Price-pane overlay studies (plotted on the primary's price scale). */
export type OverlayId = "sma20" | "sma50" | "ema20" | "ema50" | "bb" | "vwap";

/** Separate-pane oscillator/flow studies. */
export type PaneId = "rsi" | "macd" | "cvd" | "ofi" | "vpin";

/** Divergence studies (rendered as markers on the primary candles). */
export type DivergenceId = "divRsi" | "divCvd";

/** Any toggleable indicator. */
export type IndicatorId = OverlayId | PaneId | DivergenceId;

/** Static metadata for the indicator picker. */
export interface IndicatorMeta {
  id: IndicatorId;
  label: string;
  group: "overlay" | "pane" | "divergence";
  /** Requires per-bar taker-buy volume (Binance crypto only). */
  needsOrderFlow?: boolean;
}

export const INDICATORS: readonly IndicatorMeta[] = [
  { id: "sma20", label: "SMA 20", group: "overlay" },
  { id: "sma50", label: "SMA 50", group: "overlay" },
  { id: "ema20", label: "EMA 20", group: "overlay" },
  { id: "ema50", label: "EMA 50", group: "overlay" },
  { id: "bb", label: "Bollinger Bands", group: "overlay" },
  { id: "vwap", label: "VWAP (session)", group: "overlay" },
  { id: "rsi", label: "RSI (14/21/52)", group: "pane" },
  { id: "macd", label: "MACD (12,26,9)", group: "pane" },
  { id: "cvd", label: "CVD", group: "pane", needsOrderFlow: true },
  { id: "ofi", label: "OFI", group: "pane", needsOrderFlow: true },
  { id: "vpin", label: "VPIN", group: "pane", needsOrderFlow: true },
  { id: "divRsi", label: "RSI divergence", group: "divergence" },
  {
    id: "divCvd",
    label: "CVD divergence",
    group: "divergence",
    needsOrderFlow: true,
  },
] as const;
