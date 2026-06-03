import type { IndicatorId, Sentiment } from "../types";

/**
 * A classification rule for a single indicator.
 *
 * - `higherBetter`: bullish at/above a level, bearish at/below another.
 * - `lowerBetter`: bullish at/below a level, bearish at/above another.
 * - `band`: bullish inside the sweet-spot range, bearish outside the wider
 *   acceptable range, neutral in between.
 */
export type ThresholdRule =
  | { kind: "higherBetter"; bullishAtOrAbove: number; bearishAtOrBelow: number }
  | { kind: "lowerBetter"; bullishAtOrBelow: number; bearishAtOrAbove: number }
  | { kind: "band"; bullish: [number, number]; acceptable: [number, number] };

/**
 * Sentiment threshold rules per indicator. Indicators without a rule (e.g.
 * market cap) are always classified `neutral` when a value is present.
 */
export const THRESHOLDS: Partial<Record<IndicatorId, ThresholdRule>> = {
  pe: { kind: "lowerBetter", bullishAtOrBelow: 15, bearishAtOrAbove: 35 },
  pb: { kind: "lowerBetter", bullishAtOrBelow: 1.5, bearishAtOrAbove: 5 },
  ps: { kind: "lowerBetter", bullishAtOrBelow: 2, bearishAtOrAbove: 10 },
  peg: { kind: "band", bullish: [0, 1], acceptable: [0, 2] },
  evEbitda: { kind: "lowerBetter", bullishAtOrBelow: 10, bearishAtOrAbove: 18 },
  dividendYield: {
    kind: "higherBetter",
    bullishAtOrAbove: 3,
    bearishAtOrBelow: 0.5,
  },
  payoutRatio: { kind: "band", bullish: [20, 60], acceptable: [0, 90] },
  eps: { kind: "higherBetter", bullishAtOrAbove: 1, bearishAtOrBelow: 0 },
  roe: { kind: "higherBetter", bullishAtOrAbove: 15, bearishAtOrBelow: 5 },
  roa: { kind: "higherBetter", bullishAtOrAbove: 8, bearishAtOrBelow: 2 },
  netProfitMargin: {
    kind: "higherBetter",
    bullishAtOrAbove: 15,
    bearishAtOrBelow: 2,
  },
  currentRatio: { kind: "band", bullish: [1.5, 3], acceptable: [1, 5] },
  quickRatio: { kind: "band", bullish: [1, 2], acceptable: [0.7, 4] },
  debtToEquity: {
    kind: "lowerBetter",
    bullishAtOrBelow: 0.5,
    bearishAtOrAbove: 2,
  },
  interestCoverage: {
    kind: "higherBetter",
    bullishAtOrAbove: 5,
    bearishAtOrBelow: 1.5,
  },
  freeCashFlow: {
    kind: "higherBetter",
    bullishAtOrAbove: 1,
    bearishAtOrBelow: 0,
  },
  revenueGrowthYoY: {
    kind: "higherBetter",
    bullishAtOrAbove: 10,
    bearishAtOrBelow: 0,
  },
  beta: { kind: "band", bullish: [0.7, 1.2], acceptable: [0, 2] },
  volatility30d: {
    kind: "lowerBetter",
    bullishAtOrBelow: 40,
    bearishAtOrAbove: 80,
  },
  assetTurnover: {
    kind: "higherBetter",
    bullishAtOrAbove: 1,
    bearishAtOrBelow: 0.3,
  },
  nvtRatio: { kind: "lowerBetter", bullishAtOrBelow: 30, bearishAtOrAbove: 90 },
};

/**
 * Classify an indicator value into a {@link Sentiment}.
 *
 * @param id - The indicator identifier.
 * @param value - The numeric value, or `null` when unavailable.
 * @returns `"unknown"` for null, `"neutral"` when no rule applies, otherwise the
 *   bullish/neutral/bearish reading.
 */
export function classify(id: IndicatorId, value: number | null): Sentiment {
  if (value === null) return "unknown";

  const rule = THRESHOLDS[id];
  if (!rule) return "neutral";

  switch (rule.kind) {
    case "higherBetter": {
      if (value >= rule.bullishAtOrAbove) return "bullish";
      if (value <= rule.bearishAtOrBelow) return "bearish";
      return "neutral";
    }
    case "lowerBetter": {
      if (value <= rule.bullishAtOrBelow) return "bullish";
      if (value >= rule.bearishAtOrAbove) return "bearish";
      return "neutral";
    }
    case "band": {
      const [bullishLow, bullishHigh] = rule.bullish;
      const [acceptableLow, acceptableHigh] = rule.acceptable;
      if (value >= bullishLow && value <= bullishHigh) return "bullish";
      if (value < acceptableLow || value > acceptableHigh) return "bearish";
      return "neutral";
    }
  }
}
