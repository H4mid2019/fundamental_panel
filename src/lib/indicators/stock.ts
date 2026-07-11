import type { Indicator, IndicatorId, StockFundamentals } from "../types";

import { getDefinition } from "./definitions";
import { classify } from "./thresholds";

/** Broad-market reference averages used for the "vs sector" hint. */
export const SECTOR_AVERAGES: Partial<Record<IndicatorId, number>> = {
  pe: 22,
  pb: 3.5,
  ps: 2.5,
  peg: 1.6,
  pegy: 1.3,
  evEbitda: 13,
  dividendYield: 1.8,
  payoutRatio: 38,
  roe: 14,
  roa: 7,
  netProfitMargin: 11,
  currentRatio: 1.6,
  debtToEquity: 0.9,
};

/**
 * PEGY (Lynch) ratio: P/E divided by the sum of the earnings growth rate and the
 * dividend yield — PEG that also credits the income a shareholder is paid.
 *
 * The normalized fundamentals carry PEG rather than a raw growth rate, so the
 * growth rate is recovered as `P/E ÷ PEG` (both are provider-normalized, and the
 * P/E cancels, keeping the result self-consistent whichever provider supplied
 * them). Growth and yield are both expressed in percent.
 *
 * Returns `null` when the inputs can't produce a meaningful ratio: a loss-making
 * P/E, a missing/zero PEG, or a non-positive growth-plus-yield denominator
 * (shrinking earnings with no dividend to offset them).
 *
 * @param f - Normalized stock fundamentals.
 * @returns The PEGY ratio rounded to 2dp, or `null`.
 */
export function computePegy(f: StockFundamentals): number | null {
  const { peRatio: pe, pegRatio: peg, dividendYield: yield_ } = f;
  if (pe === null || peg === null || yield_ === null) return null;
  if (
    !Number.isFinite(pe) ||
    !Number.isFinite(peg) ||
    !Number.isFinite(yield_)
  ) {
    return null;
  }
  // A negative P/E means losses; PEGY is only meaningful for profitable firms.
  if (pe <= 0 || peg === 0) return null;

  const growthPct = pe / peg;
  const denominator = growthPct + yield_;
  if (denominator <= 0) return null;

  return Math.round((pe / denominator) * 100) / 100;
}

/** Build a fully-resolved indicator from a value + optional metadata. */
function makeIndicator(
  id: IndicatorId,
  value: number | null,
  extras?: { historicalRange?: { min: number; max: number } },
): Indicator {
  const definition = getDefinition(id);
  const sectorAverage = SECTOR_AVERAGES[id];
  return {
    ...definition,
    value,
    sentiment: classify(id, value),
    ...(sectorAverage !== undefined ? { sectorAverage } : {}),
    ...(extras?.historicalRange
      ? { historicalRange: extras.historicalRange }
      : {}),
  };
}

/**
 * Build the ordered list of 21 indicators for a stock or index.
 *
 * @param f - Normalized stock/index fundamentals.
 * @returns The 21 indicators in display order.
 */
export function buildStockIndicators(f: StockFundamentals): Indicator[] {
  return [
    makeIndicator("pe", f.peRatio),
    makeIndicator("pb", f.pbRatio),
    makeIndicator("ps", f.psRatio),
    makeIndicator("peg", f.pegRatio),
    makeIndicator("pegy", computePegy(f)),
    makeIndicator("evEbitda", f.evToEbitda),
    makeIndicator("dividendYield", f.dividendYield),
    makeIndicator("payoutRatio", f.payoutRatio),
    makeIndicator("eps", f.eps),
    makeIndicator("roe", f.roe),
    makeIndicator("roa", f.roa),
    makeIndicator("netProfitMargin", f.netProfitMargin),
    makeIndicator("currentRatio", f.currentRatio),
    makeIndicator("quickRatio", f.quickRatio),
    makeIndicator("debtToEquity", f.debtToEquity),
    makeIndicator("interestCoverage", f.interestCoverage),
    makeIndicator("freeCashFlow", f.freeCashFlow),
    makeIndicator("revenueGrowthYoY", f.revenueGrowthYoY),
    makeIndicator("marketCap", f.marketCap),
    makeIndicator("beta", f.beta),
    makeIndicator("assetTurnover", f.assetTurnover),
  ];
}
