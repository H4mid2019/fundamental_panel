import type { Indicator, IndicatorId, StockFundamentals } from "../types";

import { getDefinition } from "./definitions";
import { classify } from "./thresholds";

/** Broad-market reference averages used for the "vs sector" hint. */
const SECTOR_AVERAGES: Partial<Record<IndicatorId, number>> = {
  pe: 22,
  pb: 3.5,
  ps: 2.5,
  peg: 1.6,
  evEbitda: 13,
  dividendYield: 1.8,
  payoutRatio: 38,
  roe: 14,
  roa: 7,
  netProfitMargin: 11,
  currentRatio: 1.6,
  debtToEquity: 0.9,
};

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
 * Build the ordered list of 20 indicators for a stock or index.
 *
 * @param f - Normalized stock/index fundamentals.
 * @returns The 20 indicators in display order.
 */
export function buildStockIndicators(f: StockFundamentals): Indicator[] {
  return [
    makeIndicator("pe", f.peRatio),
    makeIndicator("pb", f.pbRatio),
    makeIndicator("ps", f.psRatio),
    makeIndicator("peg", f.pegRatio),
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
