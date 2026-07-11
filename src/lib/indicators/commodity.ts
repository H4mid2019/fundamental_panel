import type { CommodityFundamentals, Indicator, IndicatorId } from "../types";

import { getDefinition } from "./definitions";
import { classify } from "./thresholds";

/** Build a fully-resolved indicator, classified with commodity-specific bands. */
function makeIndicator(id: IndicatorId, value: number | null): Indicator {
  return {
    ...getDefinition(id),
    value,
    sentiment: classify(id, value, "commodity"),
  };
}

/**
 * Build the indicator list for a commodity.
 *
 * Futures have no company fundamentals, so instead of rendering a grid of "N/A"
 * valuation cards this is a price-action profile: realized volatility, trend
 * versus the 200-day average, position within the 52-week range, and momentum.
 *
 * @param f - Normalized commodity fundamentals.
 * @returns The commodity indicators in display order.
 */
export function buildCommodityIndicators(
  f: CommodityFundamentals,
): Indicator[] {
  return [
    makeIndicator("trendVs200d", f.trendVs200d),
    makeIndicator("rsi14", f.rsi14),
    makeIndicator("from52wHigh", f.from52wHigh),
    makeIndicator("from52wLow", f.from52wLow),
    makeIndicator("volatility30d", f.volatility30d),
    makeIndicator("volatility90d", f.volatility90d),
  ];
}
