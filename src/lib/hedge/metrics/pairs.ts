/**
 * Ratio-pair z-scores, with a mean-reversion guard.
 *
 * Two independent traps here, and the codebase has already been bitten by one of
 * them:
 *
 *  1. **Alignment.** The two legs trade on different calendars (GLD and GDX share
 *     a calendar; CPER and GLD do not always). Zipping two close series by index
 *     silently pairs Monday's numerator with Tuesday's denominator the moment one
 *     leg has a holiday the other does not. The denominator is therefore
 *     forward-filled onto the numerator's timestamps — the same approach as
 *     `src/lib/chart/pairs.ts`.
 *
 *  2. **Mean reversion.** A z-score says "stretched". It does *not* say "expect a
 *     snap-back" unless the spread actually pulls toward a mean. A structurally
 *     broken pair — one leg permanently re-rating — diverges forever, its z-score
 *     pins at an extreme, and a scanner that fades it keeps fading it all the way
 *     down. The Ornstein-Uhlenbeck half-life is what separates the two cases, and
 *     a pair that fails it is reported but never ranked.
 */

import type { Candle } from "../../chart/types";
import type { PairConfig } from "../config";
import { ouHalfLife, mean, stdev, type MeanReversion } from "../math/stats";

/** The computed state of one configured pair. */
export interface PairMetric {
  pairId: string;
  label: string;
  numerator: string;
  denominator: string;
  /** Latest close ratio. */
  ratio: number | null;
  /** Rolling mean of the log-ratio spread. */
  mean: number | null;
  /** Rolling standard deviation of the log-ratio spread. */
  sd: number | null;
  /** Z-score of the current log-ratio against its rolling window. */
  zScore: number | null;
  /** OLS estimate of the OU coefficient; mean reversion requires it to be < 0. */
  ouLambda: number | null;
  /** Half-life in trading days, or `null` when the spread does not revert. */
  halfLife: number | null;
  /** Whether the z-score is tradeable at all. */
  meanReversion: MeanReversion;
  /** Engle-Granger cointegration is not yet implemented; always `unknown`. */
  cointegration: "pass" | "fail" | "unknown";
  /**
   * True only when the spread mean-reverts within the configured band. A `false`
   * here means the z-score is displayed for context but is NOT a trade signal.
   */
  tradeable: boolean;
  /** The z-score series, for the sparkline. */
  series: { time: number; value: number }[];
}

/**
 * Align two candle series by forward-filling the denominator.
 *
 * Each numerator bar is divided by the most recent denominator close at or before
 * that bar's timestamp. Bars before the first denominator observation are dropped
 * rather than guessed at.
 *
 * @param numerator - Numerator candles, any order.
 * @param denominator - Denominator candles, any order.
 * @returns Aligned `(time, ratio)` points, ascending by time.
 */
export function alignedRatio(
  numerator: readonly Candle[],
  denominator: readonly Candle[],
): { time: number; value: number }[] {
  if (numerator.length === 0 || denominator.length === 0) return [];

  const den = [...denominator].sort((a, b) => a.time - b.time);
  const num = [...numerator].sort((a, b) => a.time - b.time);

  const out: { time: number; value: number }[] = [];
  let di = 0;
  let lastDen: number | null = null;

  for (const bar of num) {
    // Advance to the latest denominator bar at or before this numerator bar.
    let d = den[di];
    while (d && d.time <= bar.time) {
      if (d.close > 0) lastDen = d.close;
      di += 1;
      d = den[di];
    }
    if (lastDen === null || lastDen <= 0 || bar.close <= 0) continue;
    out.push({ time: bar.time, value: bar.close / lastDen });
  }
  return out;
}

/**
 * Compute a pair's z-score, half-life and mean-reversion verdict.
 *
 * The spread is the **log** ratio, not the raw ratio: a ratio is bounded below by
 * zero and its distribution is right-skewed, so a z-score on the raw level treats
 * a move from 1.0 to 1.2 as larger than one from 0.8 to 1.0 when they are the same
 * proportional move. The OU fit assumes a roughly symmetric, additive process,
 * which the log ratio is and the raw ratio is not.
 *
 * @param pair - The configured pair.
 * @param numerator - Numerator candles.
 * @param denominator - Denominator candles.
 * @param lookbackDays - Rolling window for the mean, sd and z-score.
 * @param minHalfLife - Shortest tradeable half-life, in trading days.
 * @param maxHalfLife - Longest tradeable half-life, in trading days.
 * @returns The pair metric. Never throws.
 */
export function computePair(
  pair: PairConfig,
  numerator: readonly Candle[],
  denominator: readonly Candle[],
  lookbackDays: number,
  minHalfLife: number,
  maxHalfLife: number,
): PairMetric {
  const base: PairMetric = {
    pairId: pair.id,
    label: pair.label,
    numerator: pair.numerator,
    denominator: pair.denominator,
    ratio: null,
    mean: null,
    sd: null,
    zScore: null,
    ouLambda: null,
    halfLife: null,
    meanReversion: "unknown",
    cointegration: "unknown",
    tradeable: false,
    series: [],
  };

  const ratios = alignedRatio(numerator, denominator);
  if (ratios.length < 20) return base;

  const spread = ratios.map((p) => ({
    time: p.time,
    value: Math.log(p.value),
  }));

  // The OU fit uses the full aligned history — the more observations, the better
  // the half-life estimate — while the z-score uses only the rolling window.
  const fit = ouHalfLife(
    spread.map((p) => p.value),
    minHalfLife,
    maxHalfLife,
  );

  const window = spread.slice(-lookbackDays).map((p) => p.value);
  const m = mean(window);
  const sd = stdev(window);
  const latest = ratios[ratios.length - 1];
  const latestSpread = spread[spread.length - 1];

  const z =
    m !== null && sd !== null && sd > 1e-12 && latestSpread
      ? (latestSpread.value - m) / sd
      : null;

  // A rolling z-score series for the sparkline, using the same window.
  const series: { time: number; value: number }[] = [];
  for (let i = lookbackDays; i < spread.length; i += 1) {
    const w = spread.slice(i - lookbackDays, i).map((p) => p.value);
    const wm = mean(w);
    const wsd = stdev(w);
    const point = spread[i];
    if (wm === null || wsd === null || wsd <= 1e-12 || !point) continue;
    series.push({ time: point.time, value: (point.value - wm) / wsd });
  }

  const meanReversion: MeanReversion = fit?.verdict ?? "unknown";

  return {
    ...base,
    ratio: latest?.value ?? null,
    mean: m,
    sd,
    zScore: z,
    ouLambda: fit?.lambda ?? null,
    halfLife: fit?.halfLife ?? null,
    meanReversion,
    // A z-score is only a signal if the spread reverts. Everything else is a
    // trend, and fading a trend on a z-score is how you lose money slowly.
    tradeable: meanReversion === "pass" && z !== null,
    series,
  };
}
