/**
 * Ratio-pair math: combine two candle legs into a synthetic "numerator /
 * denominator" series (e.g. `S&P 500 / Gold`, `BTC / Gold`).
 *
 * Legs may come from different sources with different trading hours, so the
 * denominator is forward-filled: each numerator bar is divided by the most
 * recent denominator close at or before that bar's open time. Highs/lows are
 * recomputed from the divided OHLC so wicks never invert.
 */

import type { Candle } from "./types";

/** Build the display label for a ratio pair. */
export function ratioLabel(numerator: string, denominator: string): string {
  return `${numerator} / ${denominator}`;
}

/**
 * Compute synthetic ratio candles from two legs.
 *
 * @param numerator - The numerator leg (ascending time).
 * @param denominator - The denominator leg (ascending time).
 * @returns Ratio candles aligned to the numerator's timestamps; bars before the
 *   first available denominator value are dropped.
 */
export function computeRatioCandles(
  numerator: readonly Candle[],
  denominator: readonly Candle[],
): Candle[] {
  if (numerator.length === 0 || denominator.length === 0) return [];

  // Denominator closes sorted ascending for a forward-fill walk.
  const den = [...denominator].sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  let di = 0;
  let lastDenClose: number | null = null;

  for (const bar of [...numerator].sort((a, b) => a.time - b.time)) {
    // Advance the denominator pointer to the latest bar at or before `bar.time`.
    let denBar = den[di];
    while (denBar && denBar.time <= bar.time) {
      lastDenClose = denBar.close;
      di += 1;
      denBar = den[di];
    }
    if (lastDenClose === null || lastDenClose === 0) continue;

    const open = bar.open / lastDenClose;
    const close = bar.close / lastDenClose;
    const high = bar.high / lastDenClose;
    const low = bar.low / lastDenClose;
    out.push({
      time: bar.time,
      open,
      close,
      high: Math.max(open, close, high, low),
      low: Math.min(open, close, high, low),
      // Volume and order-flow are undefined for a derived ratio.
      volume: null,
    });
  }
  return out;
}
