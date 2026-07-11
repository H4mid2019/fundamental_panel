/**
 * Statistics for the metrics engine: EWMA volatility, z-scores, percentile
 * ranks, rolling correlation, and the Ornstein-Uhlenbeck mean-reversion test
 * that decides whether a pair z-score means anything at all.
 *
 * Everything here is pure and total: `null` rather than `NaN` when there is not
 * enough data, because a `NaN` that reaches a scanner becomes a silently
 * unranked (or wrongly ranked) setup, whereas a `null` is a fact the UI can show.
 */

/** Trading sessions per year — matches `indicators/priceAction.ts`. */
export const TRADING_DAYS = 252;

/** Sample mean, or `null` when empty. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample standard deviation (Bessel-corrected); `null` with fewer than 2 points. */
export function stdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  let acc = 0;
  for (const v of values) acc += (v - m) ** 2;
  return Math.sqrt(acc / (values.length - 1));
}

/**
 * Z-score of `value` against a history.
 *
 * @param value - The current observation.
 * @param history - The trailing sample.
 * @returns The z-score, or `null` when the sample is too small or has no spread
 *   (a constant history makes every z-score infinite, which is not a signal).
 */
export function zScore(
  value: number,
  history: readonly number[],
): number | null {
  const m = mean(history);
  const s = stdev(history);
  if (m === null || s === null || s <= 1e-12) return null;
  return (value - m) / s;
}

/**
 * Percentile rank of `value` within a history, in [0, 100].
 *
 * Uses the fraction of observations strictly below `value` plus half the ties,
 * which is the standard mid-rank definition and avoids a value equal to the
 * whole history reporting either 0 or 100.
 *
 * @param value - The current observation.
 * @param history - The trailing sample.
 * @returns The percentile in [0, 100], or `null` on an empty history.
 */
export function percentileRank(
  value: number,
  history: readonly number[],
): number | null {
  if (history.length === 0) return null;
  let below = 0;
  let equal = 0;
  for (const h of history) {
    if (h < value) below += 1;
    else if (h === value) equal += 1;
  }
  return ((below + 0.5 * equal) / history.length) * 100;
}

/**
 * Rank of `value` within the min-max range of a history, in [0, 100].
 *
 * This is what "IV rank" classically means — position within the trailing
 * high-low range — as distinct from "IV percentile", which is
 * {@link percentileRank}. They differ, sometimes a lot: one outlier spike drags
 * the *rank* down for a year while barely moving the *percentile*. Both are
 * reported, because traders read them differently.
 *
 * @param value - The current observation.
 * @param history - The trailing sample.
 * @returns The range rank in [0, 100], or `null` when the history has no range.
 */
export function rangeRank(
  value: number,
  history: readonly number[],
): number | null {
  if (history.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of history) {
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  if (hi - lo <= 1e-12) return null;

  // Clamped to [0, 100]. IV rank is *defined* on that interval, and a reading of
  // 200 is not "twice as extreme" — it is a number the scale cannot express, and
  // downstream thresholds ("IV rank < 25") would silently misbehave on it.
  const rank = ((value - lo) / (hi - lo)) * 100;
  return Math.min(100, Math.max(0, rank));
}

/** Daily log returns from a close series. */
export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev === undefined || cur === undefined || prev <= 0 || cur <= 0)
      continue;
    out.push(Math.log(cur / prev));
  }
  return out;
}

/** Minimum returns needed to seed the EWMA recursion. */
const EWMA_SEED = 20;

/**
 * EWMA (RiskMetrics) annualized volatility, in **percent**.
 *
 *   sigma^2_t = lambda * sigma^2_(t-1) + (1 - lambda) * r^2_(t-1)
 *
 * This is the cheap 80% of GARCH: it captures volatility clustering — the fact
 * that today's vol depends on yesterday's — with no fitting, no optimizer and no
 * numerical failure modes. A flat 20-day standard deviation weights a shock from
 * 19 days ago exactly as heavily as yesterday's and then drops it off a cliff on
 * day 21; EWMA decays it smoothly, which is why it is the better realized-vol
 * *forecast* and therefore the right thing to compare implied vol against.
 *
 * Seeded with the sample variance of the first {@link EWMA_SEED} returns.
 *
 * @param returns - Daily log returns, oldest first.
 * @param lambda - Decay factor in (0, 1). 0.94 is the RiskMetrics daily standard.
 * @returns Annualized volatility in percent, or `null` without enough returns.
 */
export function ewmaVolatility(
  returns: readonly number[],
  lambda: number,
): number | null {
  if (lambda <= 0 || lambda >= 1) return null;
  if (returns.length < EWMA_SEED) return null;

  const seed = returns.slice(0, EWMA_SEED);
  const seedSd = stdev(seed);
  if (seedSd === null) return null;

  let variance = seedSd * seedSd;
  for (let i = EWMA_SEED; i < returns.length; i += 1) {
    const r = returns[i - 1];
    if (r === undefined) continue;
    variance = lambda * variance + (1 - lambda) * r * r;
  }
  if (!Number.isFinite(variance) || variance < 0) return null;

  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS) * 100;
}

/**
 * Simple annualized realized volatility over the last `window` returns, in percent.
 *
 * Kept alongside {@link ewmaVolatility} because it is the number most traders
 * quote and eyeball, even though EWMA is the better forecast.
 *
 * @param returns - Daily log returns, oldest first.
 * @param window - Trailing sample size.
 * @returns Annualized volatility in percent, or `null` without enough returns.
 */
export function realizedVolatility(
  returns: readonly number[],
  window: number,
): number | null {
  if (window < 2 || returns.length < window) return null;
  const s = stdev(returns.slice(-window));
  if (s === null) return null;
  return s * Math.sqrt(TRADING_DAYS) * 100;
}

/**
 * Pearson correlation of two equal-length series.
 *
 * @param a - First series.
 * @param b - Second series, aligned index-for-index with `a`.
 * @returns The correlation in [-1, 1], or `null` when too short or degenerate.
 */
export function correlation(
  a: readonly number[],
  b: readonly number[],
): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;

  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  if (mx === null || my === null) return null;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined || yi === undefined) continue;
    const dx = xi - mx;
    const dy = yi - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  if (denom <= 1e-12) return null;
  return sxy / denom;
}

/** An ordinary-least-squares fit of `y = intercept + slope * x`. */
export interface OlsFit {
  intercept: number;
  slope: number;
  /** Coefficient of determination in [0, 1]. */
  r2: number;
  /** Number of observations used. */
  n: number;
}

/**
 * Ordinary least squares of `y` on `x`.
 *
 * @param x - Regressor.
 * @param y - Regressand, aligned index-for-index with `x`.
 * @returns The fit, or `null` when too short or `x` has no variance.
 */
export function ols(x: readonly number[], y: readonly number[]): OlsFit | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;

  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  if (mx === null || my === null) return null;

  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined || yi === undefined) continue;
    sxy += (xi - mx) * (yi - my);
    sxx += (xi - mx) ** 2;
  }
  if (sxx <= 1e-12) return null;

  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const xi = x[i];
    const yi = y[i];
    if (xi === undefined || yi === undefined) continue;
    ssRes += (yi - (intercept + slope * xi)) ** 2;
    ssTot += (yi - my) ** 2;
  }
  const r2 = ssTot <= 1e-12 ? 0 : 1 - ssRes / ssTot;

  return { intercept, slope, r2, n };
}

/** Whether a spread mean-reverts fast enough for a z-score to be tradeable. */
export type MeanReversion = "pass" | "fail" | "unknown";

/** The Ornstein-Uhlenbeck fit of a spread series. */
export interface OuFit {
  /** The AR coefficient. Mean reversion requires lambda < 0. */
  lambda: number;
  /** −ln(2)/lambda, in the same units as the series (trading days). */
  halfLife: number | null;
  /** How much of the change in the spread the level explains. */
  r2: number;
  verdict: MeanReversion;
}

/**
 * Estimate the Ornstein-Uhlenbeck half-life of a spread by OLS.
 *
 *   ds_t = a + lambda * s_(t-1) + eps
 *   half_life = -ln(2) / lambda        (meaningful only when lambda < 0)
 *
 * This is the guard that makes a pair z-score mean something. A z-score says
 * "stretched" — but "stretched" only implies "expect a snap-back" if the spread
 * actually pulls toward its mean. A structurally broken pair (one leg permanently
 * re-rating) has no mean to revert to: it diverges, its z-score stays extreme,
 * and a scanner that fades it will keep fading it all the way down. Rejecting
 * `lambda >= 0` is what stops that.
 *
 * A half-life can also be *too short* (a couple of days is microstructure noise,
 * not a trade) or *too long* (a 400-day half-life is a trend wearing a spread's
 * clothing), so both bounds are checked.
 *
 * @param spread - The spread series (use the log-ratio), oldest first.
 * @param minHalfLife - Shortest acceptable half-life, in observations.
 * @param maxHalfLife - Longest acceptable half-life, in observations.
 * @returns The fit and verdict, or `null` when the series is too short.
 */
export function ouHalfLife(
  spread: readonly number[],
  minHalfLife: number,
  maxHalfLife: number,
): OuFit | null {
  if (spread.length < 20) return null;

  const lagged: number[] = [];
  const deltas: number[] = [];
  for (let i = 1; i < spread.length; i += 1) {
    const prev = spread[i - 1];
    const cur = spread[i];
    if (prev === undefined || cur === undefined) continue;
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    lagged.push(prev);
    deltas.push(cur - prev);
  }

  const fit = ols(lagged, deltas);
  if (!fit) return null;

  const lambda = fit.slope;

  // lambda >= 0 means the spread does not pull back toward a mean at all — it is
  // a random walk or an outright divergence. There is no half-life to speak of,
  // and the honest answer is to say so rather than to emit a large number.
  if (lambda >= 0) {
    return { lambda, halfLife: null, r2: fit.r2, verdict: "fail" };
  }

  const halfLife = -Math.LN2 / lambda;
  if (!Number.isFinite(halfLife) || halfLife <= 0) {
    return { lambda, halfLife: null, r2: fit.r2, verdict: "fail" };
  }

  const verdict: MeanReversion =
    halfLife >= minHalfLife && halfLife <= maxHalfLife ? "pass" : "fail";

  return { lambda, halfLife, r2: fit.r2, verdict };
}
