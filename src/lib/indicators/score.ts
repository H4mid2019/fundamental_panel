import type { Indicator, IndicatorCategory, IndicatorId } from "../types";

import { THRESHOLDS } from "./thresholds";

/** Relative importance of each indicator category. */
export const CATEGORY_WEIGHTS: Record<IndicatorCategory, number> = {
  valuation: 1,
  profitability: 1.2,
  leverage: 1.1,
  liquidity: 0.9,
  growth: 1,
  market: 0.7,
};

const clampFrac = (n: number, span: number): number =>
  Math.min(1, Math.max(0, n / span));

/**
 * Confidence in an indicator's reading based on how far past its threshold the
 * value sits.
 *
 * @param id - The indicator id.
 * @param value - The numeric value, or `null`.
 * @returns A strength in [0, 1] (0 for unavailable, 0.3 for neutral readings).
 */
export function indicatorStrength(
  id: IndicatorId,
  value: number | null,
): number {
  if (value === null) return 0;
  const rule = THRESHOLDS[id];
  if (!rule) return 0.3;

  if (rule.kind === "higherBetter") {
    const span = Math.max(1e-9, rule.bullishAtOrAbove - rule.bearishAtOrBelow);
    if (value >= rule.bullishAtOrAbove)
      return 0.4 + 0.6 * clampFrac(value - rule.bullishAtOrAbove, span);
    if (value <= rule.bearishAtOrBelow)
      return 0.4 + 0.6 * clampFrac(rule.bearishAtOrBelow - value, span);
    return 0.3;
  }

  if (rule.kind === "lowerBetter") {
    const span = Math.max(1e-9, rule.bearishAtOrAbove - rule.bullishAtOrBelow);
    if (value <= rule.bullishAtOrBelow)
      return 0.4 + 0.6 * clampFrac(rule.bullishAtOrBelow - value, span);
    if (value >= rule.bearishAtOrAbove)
      return 0.4 + 0.6 * clampFrac(value - rule.bearishAtOrAbove, span);
    return 0.3;
  }

  const [bLow, bHigh] = rule.bullish;
  const [aLow, aHigh] = rule.acceptable;
  const span = Math.max(1e-9, bHigh - bLow);
  if (value >= bLow && value <= bHigh) return 1;
  if (value < aLow) return 0.4 + 0.6 * clampFrac(aLow - value, span);
  if (value > aHigh) return 0.4 + 0.6 * clampFrac(value - aHigh, span);
  return 0.3;
}

/** Weighted contribution of one indicator (0 when unavailable). */
export function indicatorWeight(indicator: Indicator): number {
  if (indicator.value === null || indicator.sentiment === "unknown") return 0;
  const base = CATEGORY_WEIGHTS[indicator.category];
  const strength = indicatorStrength(indicator.id, indicator.value);
  return base * (0.5 + 0.5 * strength);
}

/** A weighted breakdown of indicator sentiment plus an unavailable count. */
export interface SentimentBreakdown {
  bullish: number;
  neutral: number;
  bearish: number;
  /** Count of indicators with no value (not weighted). */
  unknown: number;
  /** Count of indicators that contributed weight. */
  scored: number;
}

/**
 * Aggregate indicators into a category- and conviction-weighted sentiment
 * breakdown.
 *
 * @param indicators - The computed indicators.
 * @returns Summed weights per sentiment plus the unavailable count.
 */
export function sentimentBreakdown(
  indicators: readonly Indicator[],
): SentimentBreakdown {
  const out = { bullish: 0, neutral: 0, bearish: 0, unknown: 0, scored: 0 };
  for (const ind of indicators) {
    if (ind.value === null || ind.sentiment === "unknown") {
      out.unknown += 1;
      continue;
    }
    const w = indicatorWeight(ind);
    if (ind.sentiment === "bullish") out.bullish += w;
    else if (ind.sentiment === "bearish") out.bearish += w;
    else out.neutral += w;
    out.scored += 1;
  }
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return {
    bullish: r1(out.bullish),
    neutral: r1(out.neutral),
    bearish: r1(out.bearish),
    unknown: out.unknown,
    scored: out.scored,
  };
}
