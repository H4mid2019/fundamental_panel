import type { IndicatorDefinition, IndicatorId } from "../types";

/** Static metadata for every indicator the dashboard can render. */
export const INDICATOR_DEFINITIONS: Record<IndicatorId, IndicatorDefinition> = {
  pe: {
    id: "pe",
    label: "P/E Ratio",
    unit: "x",
    description: "Price relative to trailing earnings per share.",
    category: "valuation",
    format: "ratio",
  },
  pb: {
    id: "pb",
    label: "P/B Ratio",
    unit: "x",
    description: "Price relative to book value per share.",
    category: "valuation",
    format: "ratio",
  },
  ps: {
    id: "ps",
    label: "P/S Ratio",
    unit: "x",
    description: "Price relative to revenue per share.",
    category: "valuation",
    format: "ratio",
  },
  peg: {
    id: "peg",
    label: "PEG Ratio",
    unit: "x",
    description: "P/E adjusted for expected earnings growth.",
    category: "valuation",
    format: "ratio",
  },
  pegy: {
    id: "pegy",
    label: "PEGY Ratio",
    unit: "x",
    description:
      "P/E adjusted for both earnings growth and dividend yield (Lynch ratio). Below 1x suggests the price is not yet paying for growth plus income.",
    category: "valuation",
    format: "ratio",
  },
  evEbitda: {
    id: "evEbitda",
    label: "EV/EBITDA",
    unit: "x",
    description: "Enterprise value relative to operating earnings.",
    category: "valuation",
    format: "ratio",
  },
  dividendYield: {
    id: "dividendYield",
    label: "Dividend Yield",
    unit: "%",
    description: "Annual dividends as a percentage of price.",
    category: "valuation",
    format: "percent",
  },
  payoutRatio: {
    id: "payoutRatio",
    label: "Payout Ratio",
    unit: "%",
    description: "Share of earnings paid out as dividends.",
    category: "valuation",
    format: "percent",
  },
  eps: {
    id: "eps",
    label: "EPS",
    unit: "$",
    description: "Net earnings per share (trailing twelve months).",
    category: "profitability",
    format: "currency",
  },
  roe: {
    id: "roe",
    label: "ROE",
    unit: "%",
    description: "Return on shareholder equity.",
    category: "profitability",
    format: "percent",
  },
  roa: {
    id: "roa",
    label: "ROA",
    unit: "%",
    description: "Return on total assets.",
    category: "profitability",
    format: "percent",
  },
  netProfitMargin: {
    id: "netProfitMargin",
    label: "Net Profit Margin",
    unit: "%",
    description: "Net income as a percentage of revenue.",
    category: "profitability",
    format: "percent",
  },
  currentRatio: {
    id: "currentRatio",
    label: "Current Ratio",
    unit: "x",
    description: "Current assets relative to current liabilities.",
    category: "liquidity",
    format: "ratio",
  },
  quickRatio: {
    id: "quickRatio",
    label: "Quick Ratio",
    unit: "x",
    description: "Liquid assets relative to current liabilities.",
    category: "liquidity",
    format: "ratio",
  },
  debtToEquity: {
    id: "debtToEquity",
    label: "Debt-to-Equity",
    unit: "x",
    description: "Total debt relative to shareholder equity.",
    category: "leverage",
    format: "ratio",
  },
  interestCoverage: {
    id: "interestCoverage",
    label: "Interest Coverage",
    unit: "x",
    description: "Operating earnings relative to interest expense.",
    category: "leverage",
    format: "ratio",
  },
  freeCashFlow: {
    id: "freeCashFlow",
    label: "Free Cash Flow",
    unit: "$",
    description: "Cash generated after capital expenditure.",
    category: "profitability",
    format: "largeCurrency",
  },
  revenueGrowthYoY: {
    id: "revenueGrowthYoY",
    label: "Revenue Growth YoY",
    unit: "%",
    description: "Year-over-year revenue growth.",
    category: "growth",
    format: "percent",
  },
  marketCap: {
    id: "marketCap",
    label: "Market Cap",
    unit: "$",
    description: "Total market value of the asset.",
    category: "market",
    format: "largeCurrency",
  },
  beta: {
    id: "beta",
    label: "Beta",
    unit: "",
    description: "Volatility relative to the broad market.",
    category: "market",
    format: "number",
  },
  volatility30d: {
    id: "volatility30d",
    label: "Volatility 30d",
    unit: "%",
    description: "Annualized 30-day price volatility.",
    category: "market",
    format: "percent",
  },
  volatility90d: {
    id: "volatility90d",
    label: "Volatility 90d",
    unit: "%",
    description:
      "Annualized 90-day price volatility — the calmer, structural read next to the 30-day figure.",
    category: "market",
    format: "percent",
  },
  trendVs200d: {
    id: "trendVs200d",
    label: "Trend vs 200d MA",
    unit: "%",
    description:
      "Price above (+) or below (−) its 200-day moving average. Above signals a durable uptrend.",
    category: "market",
    format: "percent",
  },
  from52wHigh: {
    id: "from52wHigh",
    label: "From 52w High",
    unit: "%",
    description:
      "Distance below the 52-week high. Near zero means the asset is pressing its highs.",
    category: "market",
    format: "percent",
  },
  from52wLow: {
    id: "from52wLow",
    label: "From 52w Low",
    unit: "%",
    description:
      "Distance above the 52-week low. A large gap means the asset has already run a long way.",
    category: "market",
    format: "percent",
  },
  rsi14: {
    id: "rsi14",
    label: "RSI (14)",
    unit: "",
    description:
      "Wilder's 14-day momentum oscillator. Extremes at either end (below 20 or above 80) signal exhaustion risk.",
    category: "market",
    format: "number",
  },
  assetTurnover: {
    id: "assetTurnover",
    label: "Asset Turnover",
    unit: "x",
    description: "Revenue generated per dollar of assets.",
    category: "profitability",
    format: "ratio",
  },
  nvtRatio: {
    id: "nvtRatio",
    label: "NVT Ratio",
    unit: "x",
    description: "Network value relative to transaction volume.",
    category: "valuation",
    format: "ratio",
  },
};

/**
 * Get the static definition for an indicator.
 *
 * @param id - The indicator identifier.
 * @returns The indicator's metadata.
 */
export function getDefinition(id: IndicatorId): IndicatorDefinition {
  return INDICATOR_DEFINITIONS[id];
}
