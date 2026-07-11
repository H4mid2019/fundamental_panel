/**
 * Price-action statistics derived from daily candles.
 *
 * These stand in for fundamentals on assets that have none (commodities /
 * futures): realized volatility, trend versus the 200-day average, position in
 * the 52-week range and momentum. Reuses the chart library's `sma`/`rsi`.
 */

import { rsi, sma } from "../chart/indicators";
import type { Candle } from "../chart/types";

/** Trading sessions per year, used to annualize daily volatility. */
const TRADING_DAYS = 252;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Annualized realized volatility (percent) over the trailing `lookback`
 * sessions, from the standard deviation of daily log returns.
 *
 * @param candles - Daily candles in ascending time order.
 * @param lookback - Number of trailing sessions (e.g. 30 or 90).
 * @returns The annualized volatility in percent, or `null` without enough bars.
 */
export function annualizedVolatility(
  candles: readonly Candle[],
  lookback: number,
): number | null {
  if (lookback < 2 || candles.length < lookback + 1) return null;

  const window = candles.slice(-(lookback + 1));
  const returns: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    const prev = window[i - 1];
    const cur = window[i];
    if (!prev || !cur || prev.close <= 0 || cur.close <= 0) continue;
    returns.push(Math.log(cur.close / prev.close));
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((a, r) => a + r, 0) / returns.length;
  const variance =
    returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  return round1(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS) * 100);
}

/** The price-action profile consumed by the commodity indicator builder. */
export interface PriceAction {
  volatility30d: number | null;
  volatility90d: number | null;
  trendVs200d: number | null;
  from52wHigh: number | null;
  from52wLow: number | null;
  rsi14: number | null;
}

/**
 * Compute the full price-action profile from daily candles.
 *
 * @param candles - Daily candles in ascending time order.
 * @returns Each metric, or `null` where there aren't enough bars for it.
 */
export function computePriceAction(candles: readonly Candle[]): PriceAction {
  const last = candles[candles.length - 1];
  const close = last?.close ?? null;

  // Trend vs the 200-day moving average.
  const sma200 = sma(candles, 200);
  const lastSma = sma200[sma200.length - 1]?.value ?? null;
  const trendVs200d =
    close !== null && lastSma !== null && lastSma > 0
      ? round1((close / lastSma - 1) * 100)
      : null;

  // Position within the trailing 52-week range.
  const year = candles.slice(-TRADING_DAYS);
  let high = -Infinity;
  let low = Infinity;
  for (const bar of year) {
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
  }
  const hasRange =
    year.length > 0 && Number.isFinite(high) && Number.isFinite(low);
  const from52wHigh =
    hasRange && close !== null && high > 0
      ? round1((close / high - 1) * 100)
      : null;
  const from52wLow =
    hasRange && close !== null && low > 0
      ? round1((close / low - 1) * 100)
      : null;

  const rsiSeries = rsi(candles, 14);
  const rsi14 = rsiSeries[rsiSeries.length - 1]?.value ?? null;

  return {
    volatility30d: annualizedVolatility(candles, 30),
    volatility90d: annualizedVolatility(candles, 90),
    trendVs200d,
    from52wHigh,
    from52wLow,
    rsi14: rsi14 === null ? null : round1(rsi14),
  };
}
