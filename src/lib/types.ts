/**
 * Shared domain types for the fundamental analysis dashboard.
 *
 * These are hand-written (not Zod-inferred) because they describe the
 * normalized internal shapes the UI consumes; the Zod schemas that validate
 * raw provider payloads live alongside each provider.
 */

/** The three asset classes the dashboard understands. */
export type AssetType = "stock" | "index" | "crypto";

/** Directional read on an indicator value. */
export type Sentiment = "bullish" | "neutral" | "bearish" | "unknown";

/** Stable identifiers for every indicator the app can render. */
export type IndicatorId =
  | "pe"
  | "pb"
  | "ps"
  | "peg"
  | "pegy"
  | "evEbitda"
  | "dividendYield"
  | "payoutRatio"
  | "eps"
  | "roe"
  | "roa"
  | "netProfitMargin"
  | "currentRatio"
  | "quickRatio"
  | "debtToEquity"
  | "interestCoverage"
  | "freeCashFlow"
  | "revenueGrowthYoY"
  | "marketCap"
  | "beta"
  | "volatility30d"
  | "assetTurnover"
  | "nvtRatio";

/** Grouping used for layout and color-coding in the grid. */
export type IndicatorCategory =
  | "valuation"
  | "profitability"
  | "liquidity"
  | "leverage"
  | "growth"
  | "market";

/** How a raw numeric value should be rendered. */
export type IndicatorFormat =
  | "ratio" // 1.23x
  | "percent" // 12.3%
  | "currency" // $1.23
  | "largeCurrency" // $1.23T
  | "number"; // 1.23

/** Static metadata describing an indicator, independent of any asset. */
export interface IndicatorDefinition {
  id: IndicatorId;
  label: string;
  unit: string;
  description: string;
  category: IndicatorCategory;
  format: IndicatorFormat;
}

/** A computed indicator for a specific asset. */
export interface Indicator extends IndicatorDefinition {
  value: number | null;
  sentiment: Sentiment;
  sectorAverage?: number;
  historicalRange?: { min: number; max: number };
}

/** Lightweight reference used by the asset selector. */
export interface AssetRef {
  symbol: string;
  name: string;
  type: AssetType;
}

/** Headline snapshot shown above the indicator grid. */
export interface AssetSnapshot {
  symbol: string;
  name: string;
  type: AssetType;
  price: number | null;
  currency: string;
  changePct: number | null;
  marketCap: number | null;
  /** Sector (stocks) or market-cap rank (crypto), when known. */
  meta?: string;
  asOf: string;
}

/** The full indicator payload for one asset. */
export interface IndicatorSet {
  symbol: string;
  assetType: AssetType;
  asOf: string;
  indicators: Indicator[];
}

/** A single macro data point for the sidebar. */
export interface MacroMetric {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  asOf: string;
}

/** Per-indicator one-line AI commentary keyed by indicator id. */
export type AIPerIndicator = Partial<Record<IndicatorId, string>>;

/** Directional trade stance. */
export type TradeStance = "long" | "short" | "avoid";

/** A hypothetical, educational trade idea (not financial advice). */
export interface TradeIdea {
  stance: TradeStance;
  /** Holding-period horizon range, e.g. "3-24 months". */
  horizon: string;
  /** The single best holding period within the range, in months (3-24). */
  bestHorizonMonths: number;
  conviction: "low" | "medium" | "high";
  rationale: string;
  /** Suggested hedge (e.g. protective put), or null when not applicable. */
  hedge: string | null;
  /** Illustrative outcome on a small hypothetical position. */
  scenario: {
    capitalEur: number;
    maxGainEur: number | null;
    maxLossEur: number | null;
    assumptions: string;
  } | null;
}

/** The AI brief returned by `/api/ai-brief`. */
export interface AIBrief {
  symbol: string;
  summary: string;
  perIndicator: AIPerIndicator;
  recommendation: TradeIdea;
  model: string;
  generatedAt: string;
  /** True when produced by the deterministic local fallback. */
  fallback: boolean;
}

/** Trailing-return performance for an asset. */
export interface PerformanceReturns {
  symbol: string;
  ytd: number | null;
  oneY: number | null;
  threeY: number | null;
  fiveY: number | null;
  asOf: string;
  fallback: boolean;
}

/** Risk-asset reading of a macro indicator. */
export type MacroReading = "good" | "bad" | "neutral" | "unknown";

/**
 * Normalized stock/index fundamentals — the provider-agnostic shape the stock
 * indicator builder consumes. Every numeric field is nullable so that indexes
 * (which lack most fundamentals) and sparse provider responses degrade cleanly.
 * Percentage fields are expressed in percent (e.g. `12.5` for 12.5%).
 */
export interface StockFundamentals {
  symbol: string;
  name: string;
  price: number | null;
  currency: string;
  changePct: number | null;
  sector: string | null;
  marketCap: number | null;
  beta: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  psRatio: number | null;
  pegRatio: number | null;
  evToEbitda: number | null;
  dividendYield: number | null;
  payoutRatio: number | null;
  eps: number | null;
  roe: number | null;
  roa: number | null;
  netProfitMargin: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  debtToEquity: number | null;
  interestCoverage: number | null;
  freeCashFlow: number | null;
  revenueGrowthYoY: number | null;
  assetTurnover: number | null;
}

/** Normalized crypto fundamentals consumed by the crypto indicator builder. */
export interface CryptoFundamentals {
  symbol: string;
  name: string;
  price: number | null;
  currency: string;
  changePct: number | null;
  rank: number | null;
  marketCap: number | null;
  fullyDilutedValuation: number | null;
  totalVolume: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  volatility30d: number | null;
  nvtRatio: number | null;
  priceChange30dPct: number | null;
}

/** Tab groups of the peer-benchmarks comparison table. */
export type PeerGroupId = "quote" | "value" | "size" | "growth" | "profit";

/** One comparison row: the asset's value vs the peer median and sector avg. */
export interface PeerMetricRow {
  id: string;
  label: string;
  format: IndicatorFormat;
  value: number | null;
  peerMedian: number | null;
  sectorAvg: number | null;
  /** Which direction reads as favorable, or `null` when neutral. */
  betterWhen: "higher" | "lower" | null;
}

/** One tab of peer-benchmark rows. */
export interface PeerGroup {
  id: PeerGroupId;
  label: string;
  rows: PeerMetricRow[];
}

/** Peer comparison payload returned by `/api/peers/[symbol]`. */
export interface PeerBenchmarks {
  symbol: string;
  peers: { symbol: string; name: string }[];
  groups: PeerGroup[];
  asOf: string;
  /** True when produced without live peer data. */
  fallback: boolean;
}

/** Reporting cadence for financial statements. */
export type StatementFrequency = "annual" | "quarterly";

/** The three financial statements. */
export type StatementKind = "income" | "balance" | "cashflow";

/** One fiscal period of a statement, keyed by line-item id. */
export interface StatementPeriod {
  /** Fiscal period end (ISO date). */
  date: string;
  /** Display label, e.g. `2025` or `Q3 '25`. */
  label: string;
  values: Record<string, number | null>;
}

/** Financial statements payload returned by `/api/financials/[symbol]`. */
export interface FinancialStatements {
  symbol: string;
  frequency: StatementFrequency;
  income: StatementPeriod[];
  balance: StatementPeriod[];
  cashflow: StatementPeriod[];
  asOf: string;
}

/** Categories of market-moving events detected in news headlines. */
export type NewsEventType =
  | "leadership"
  | "ma"
  | "earnings"
  | "guidance"
  | "legal"
  | "layoffs"
  | "partnership"
  | "product"
  | "dividend"
  | "buyback"
  | "analyst"
  | "regulatory"
  | "other";

/** Polarity of a headline. */
export type NewsSentiment = "positive" | "neutral" | "negative";

/** A single classified, weighted news article. */
export interface NewsArticle {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  summary?: string;
  eventType: NewsEventType;
  sentiment: NewsSentiment;
  /** Importance in [0, 1] from event weight × recency. */
  weight: number;
  /** Signed contribution to the news index (weight × polarity × recency). */
  impact: number;
}

/** Aggregated, weighted news analysis for one asset. */
export interface NewsAnalysis {
  symbol: string;
  /** Weighted news index in [-100, 100]. */
  index: number;
  label: NewsSentiment;
  articleCount: number;
  /** Titles of the top-weighted articles (fed to the AI brief). */
  topTitles: string[];
  /** Top-weighted articles for display. */
  articles: NewsArticle[];
  asOf: string;
  /** True when produced by the deterministic fixture fallback. */
  fallback: boolean;
}

/** A single futures contract quote. */
export interface FuturesQuote {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
  currency: string;
}

/** A single option contract (call or put). */
export interface OptionContract {
  strike: number;
  lastPrice: number | null;
  /** Implied volatility as a decimal fraction (e.g. 0.36 = 36%). */
  impliedVolatility: number | null;
  volume: number | null;
  openInterest: number | null;
  inTheMoney: boolean;
}

/** An options chain for one expiration of an underlying. */
export interface OptionsChain {
  symbol: string;
  underlyingPrice: number | null;
  /** Available expirations as ISO date strings. */
  expirations: string[];
  /** The selected expiration (ISO date string). */
  expiration: string;
  calls: OptionContract[];
  puts: OptionContract[];
  /** Put/call ratio by open interest. */
  putCallRatio: number | null;
  asOf: string;
  fallback: boolean;
}

/** A single price level in an order book. */
export interface OrderBookLevel {
  price: number;
  quantity: number;
}

/** An L2 order book snapshot for a crypto asset. */
export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midPrice: number | null;
  spread: number | null;
  spreadPct: number | null;
  /** Depth imbalance in [-1, 1]; positive = more bid volume. */
  imbalance: number | null;
  asOf: string;
  fallback: boolean;
}

/** Application-level error with a machine-readable code. */
export interface AppError {
  code:
    | "NOT_FOUND"
    | "PROVIDER_ERROR"
    | "VALIDATION_ERROR"
    | "RATE_LIMITED"
    | "UPSTREAM_TIMEOUT"
    | "UNKNOWN";
  message: string;
}

/** Discriminated-union result used by every fallible operation. */
export type Result<T, E = AppError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

/**
 * Wrap a successful value in a {@link Result}.
 *
 * @param data - The success payload.
 * @returns An `ok: true` result.
 */
export function ok<T>(data: T): Result<T, never> {
  return { ok: true, data };
}

/**
 * Wrap an error in a {@link Result}.
 *
 * @param error - The failure payload.
 * @returns An `ok: false` result.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
