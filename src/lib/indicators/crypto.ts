import type { CryptoFundamentals, Indicator, IndicatorId } from "../types";

import { getDefinition } from "./definitions";
import { classify } from "./thresholds";

/** Build a fully-resolved indicator from an id + value. */
function makeIndicator(id: IndicatorId, value: number | null): Indicator {
  return {
    ...getDefinition(id),
    value,
    sentiment: classify(id, value),
  };
}

/**
 * Build the ordered list of universal indicators for a crypto asset.
 *
 * Per spec, crypto applies the universal indicators (18–20): market cap,
 * 30-day volatility and NVT ratio. Stock-specific fundamentals are skipped.
 *
 * @param f - Normalized crypto fundamentals.
 * @returns The crypto indicators in display order.
 */
export function buildCryptoIndicators(f: CryptoFundamentals): Indicator[] {
  return [
    makeIndicator("marketCap", f.marketCap),
    makeIndicator("volatility30d", f.volatility30d),
    makeIndicator("nvtRatio", f.nvtRatio),
  ];
}
