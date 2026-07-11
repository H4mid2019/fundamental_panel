import { resolveAssetName } from "../assets";
import type {
  AssetType,
  CryptoFundamentals,
  FinancialStatements,
  FuturesQuote,
  MacroMetric,
  OptionContract,
  OrderBookLevel,
  PerformanceReturns,
  StatementFrequency,
  StatementPeriod,
  StockFundamentals,
} from "../types";

/** Raw (unclassified) news article shape shared by the provider and fixtures. */
export interface RawNewsArticle {
  id: string;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  summary?: string;
}

/**
 * Deterministic offline fixtures.
 *
 * These power local development, CI and the E2E smoke test, and act as the
 * graceful fallback whenever a provider key is missing or an upstream call
 * fails. Values are realistic but intentionally static.
 */

const STOCK_FIXTURES: Readonly<Record<string, StockFundamentals>> = {
  AAPL: {
    symbol: "AAPL",
    name: "Apple Inc.",
    price: 213.55,
    currency: "USD",
    changePct: 0.84,
    sector: "Technology",
    marketCap: 3_270_000_000_000,
    beta: 1.24,
    peRatio: 32.4,
    pbRatio: 46.1,
    psRatio: 8.3,
    pegRatio: 2.9,
    evToEbitda: 24.1,
    dividendYield: 0.46,
    payoutRatio: 15.2,
    eps: 6.59,
    roe: 147.2,
    roa: 28.1,
    netProfitMargin: 25.3,
    currentRatio: 0.92,
    quickRatio: 0.85,
    debtToEquity: 1.45,
    interestCoverage: 28.4,
    freeCashFlow: 98_400_000_000,
    revenueGrowthYoY: 6.1,
    assetTurnover: 1.07,
  },
  MSFT: {
    symbol: "MSFT",
    name: "Microsoft Corporation",
    price: 467.12,
    currency: "USD",
    changePct: -0.31,
    sector: "Technology",
    marketCap: 3_470_000_000_000,
    beta: 0.91,
    peRatio: 36.8,
    pbRatio: 11.7,
    psRatio: 13.1,
    pegRatio: 2.2,
    evToEbitda: 25.6,
    dividendYield: 0.71,
    payoutRatio: 25.1,
    eps: 12.69,
    roe: 38.5,
    roa: 17.6,
    netProfitMargin: 36.2,
    currentRatio: 1.27,
    quickRatio: 1.21,
    debtToEquity: 0.21,
    interestCoverage: 42.1,
    freeCashFlow: 74_100_000_000,
    revenueGrowthYoY: 15.7,
    assetTurnover: 0.51,
  },
  GOOGL: {
    symbol: "GOOGL",
    name: "Alphabet Inc.",
    price: 178.34,
    currency: "USD",
    changePct: 1.12,
    sector: "Communication Services",
    marketCap: 2_180_000_000_000,
    beta: 1.03,
    peRatio: 24.6,
    pbRatio: 7.1,
    psRatio: 6.4,
    pegRatio: 1.3,
    evToEbitda: 17.2,
    dividendYield: 0.45,
    payoutRatio: 8.4,
    eps: 7.25,
    roe: 30.1,
    roa: 18.2,
    netProfitMargin: 27.7,
    currentRatio: 1.95,
    quickRatio: 1.91,
    debtToEquity: 0.09,
    interestCoverage: 120.5,
    freeCashFlow: 69_500_000_000,
    revenueGrowthYoY: 13.9,
    assetTurnover: 0.74,
  },
};

const INDEX_FIXTURES: Readonly<Record<string, StockFundamentals>> = {
  "^GSPC": indexFixture("^GSPC", "S&P 500", 5460.48, 22.9, 1.0),
  "^IXIC": indexFixture("^IXIC", "Nasdaq Composite", 17689.36, 31.2, 1.18),
  "^DJI": indexFixture(
    "^DJI",
    "Dow Jones Industrial Average",
    39150.33,
    19.4,
    0.92,
  ),
  "^FTSE": indexFixture("^FTSE", "FTSE 100", 8164.12, 13.7, 0.81),
  "^N225": indexFixture("^N225", "Nikkei 225", 39583.08, 21.1, 1.05),
};

const CRYPTO_FIXTURES: Readonly<Record<string, CryptoFundamentals>> = {
  BTC: {
    symbol: "BTC",
    name: "Bitcoin",
    price: 67250.42,
    currency: "USD",
    changePct: 1.9,
    rank: 1,
    marketCap: 1_328_000_000_000,
    fullyDilutedValuation: 1_412_000_000_000,
    totalVolume: 38_400_000_000,
    circulatingSupply: 19_740_000,
    totalSupply: 21_000_000,
    volatility30d: 42.6,
    nvtRatio: 34.6,
    priceChange30dPct: 8.4,
  },
  ETH: {
    symbol: "ETH",
    name: "Ethereum",
    price: 3520.11,
    currency: "USD",
    changePct: 2.4,
    rank: 2,
    marketCap: 423_000_000_000,
    fullyDilutedValuation: 423_000_000_000,
    totalVolume: 17_900_000_000,
    circulatingSupply: 120_200_000,
    totalSupply: 120_200_000,
    volatility30d: 51.3,
    nvtRatio: 23.6,
    priceChange30dPct: 4.1,
  },
  SOL: {
    symbol: "SOL",
    name: "Solana",
    price: 146.77,
    currency: "USD",
    changePct: -1.2,
    rank: 5,
    marketCap: 67_800_000_000,
    fullyDilutedValuation: 84_200_000_000,
    totalVolume: 2_900_000_000,
    circulatingSupply: 462_000_000,
    totalSupply: 574_000_000,
    volatility30d: 68.9,
    nvtRatio: 23.4,
    priceChange30dPct: -6.7,
  },
  BNB: {
    symbol: "BNB",
    name: "BNB",
    price: 592.34,
    currency: "USD",
    changePct: 0.6,
    rank: 4,
    marketCap: 87_300_000_000,
    fullyDilutedValuation: 87_300_000_000,
    totalVolume: 1_400_000_000,
    circulatingSupply: 147_000_000,
    totalSupply: 147_000_000,
    volatility30d: 39.2,
    nvtRatio: 62.4,
    priceChange30dPct: 2.2,
  },
  XRP: {
    symbol: "XRP",
    name: "XRP",
    price: 0.4892,
    currency: "USD",
    changePct: -0.4,
    rank: 6,
    marketCap: 27_100_000_000,
    fullyDilutedValuation: 48_900_000_000,
    totalVolume: 1_100_000_000,
    circulatingSupply: 55_400_000_000,
    totalSupply: 99_990_000_000,
    volatility30d: 55.7,
    nvtRatio: 24.6,
    priceChange30dPct: -3.1,
  },
};

const MACRO_FIXTURES: readonly MacroMetric[] = [
  { id: "VIXCLS", label: "VIX", value: 13.2, unit: "", asOf: "2024-06-28" },
  { id: "DTWEXBGS", label: "DXY", value: 105.8, unit: "", asOf: "2024-06-28" },
  { id: "DGS10", label: "US 10Y", value: 4.34, unit: "%", asOf: "2024-06-28" },
  {
    id: "CPIAUCSL",
    label: "CPI YoY",
    value: 3.3,
    unit: "%",
    asOf: "2024-05-31",
  },
  {
    id: "FEDFUNDS",
    label: "Fed Funds Rate",
    value: 5.33,
    unit: "%",
    asOf: "2024-05-31",
  },
];

/** Build a sparse fundamentals record for an index (most ratios are N/A). */
function indexFixture(
  symbol: string,
  name: string,
  price: number,
  peRatio: number,
  beta: number,
): StockFundamentals {
  return {
    symbol,
    name,
    price,
    currency: "USD",
    changePct: 0.3,
    sector: null,
    marketCap: null,
    beta,
    peRatio,
    pbRatio: null,
    psRatio: null,
    pegRatio: null,
    evToEbitda: null,
    dividendYield: 1.4,
    payoutRatio: null,
    eps: null,
    roe: null,
    roa: null,
    netProfitMargin: null,
    currentRatio: null,
    quickRatio: null,
    debtToEquity: null,
    interestCoverage: null,
    freeCashFlow: null,
    revenueGrowthYoY: null,
    assetTurnover: null,
  };
}

/** Derive a plausible default stock record for symbols without a fixture. */
function syntheticStock(symbol: string): StockFundamentals {
  const seed = [...symbol].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const jitter = (base: number, spread: number): number =>
    Math.round((base + (seed % spread)) * 100) / 100;
  return {
    symbol,
    name: resolveAssetName(symbol),
    price: jitter(120, 80),
    currency: "USD",
    changePct: jitter(-1, 4),
    sector: "Diversified",
    marketCap: jitter(80, 50) * 1_000_000_000,
    beta: jitter(0.8, 1),
    peRatio: jitter(18, 15),
    pbRatio: jitter(3, 5),
    psRatio: jitter(4, 6),
    pegRatio: jitter(1.2, 2),
    evToEbitda: jitter(12, 10),
    dividendYield: jitter(1.5, 3),
    payoutRatio: jitter(30, 30),
    eps: jitter(4, 6),
    roe: jitter(15, 20),
    roa: jitter(8, 12),
    netProfitMargin: jitter(12, 15),
    currentRatio: jitter(1.5, 2),
    quickRatio: jitter(1.2, 2),
    debtToEquity: jitter(0.6, 1),
    interestCoverage: jitter(10, 20),
    freeCashFlow: jitter(5, 20) * 1_000_000_000,
    revenueGrowthYoY: jitter(6, 15),
    assetTurnover: jitter(0.6, 1),
  };
}

/**
 * Get fixture stock/index fundamentals for a symbol.
 *
 * @param symbol - The ticker to resolve.
 * @returns A fully-populated (or synthetic) fundamentals record.
 */
export function getStockFixture(symbol: string): StockFundamentals {
  const upper = symbol.toUpperCase();
  return (
    STOCK_FIXTURES[upper] ?? INDEX_FIXTURES[upper] ?? syntheticStock(upper)
  );
}

/**
 * Get fixture crypto fundamentals for a symbol.
 *
 * @param symbol - The coin ticker (e.g. `BTC`).
 * @returns The fixture record, or `null` if the coin is unknown.
 */
export function getCryptoFixture(symbol: string): CryptoFundamentals | null {
  return CRYPTO_FIXTURES[symbol.toUpperCase()] ?? null;
}

/**
 * Get the fixture macro indicators for the sidebar.
 *
 * @returns The static list of macro metrics.
 */
export function getMacroFixture(): MacroMetric[] {
  return MACRO_FIXTURES.map((m) => ({ ...m }));
}

const STOCK_NEWS_TEMPLATES: ReadonlyArray<{
  title: (name: string) => string;
  source: string;
  daysAgo: number;
}> = [
  {
    title: (n) => `${n} beats quarterly earnings expectations`,
    source: "MarketWire",
    daysAgo: 1,
  },
  {
    title: (n) => `${n} raises full-year guidance on strong demand`,
    source: "Bloomberg",
    daysAgo: 2,
  },
  {
    title: (n) => `Analysts upgrade ${n} to overweight, lift price target`,
    source: "Reuters",
    daysAgo: 3,
  },
  {
    title: (n) => `${n} announces partnership to expand AI offerings`,
    source: "TechCrunch",
    daysAgo: 4,
  },
  {
    title: (n) => `${n} unveils new product lineup`,
    source: "The Verge",
    daysAgo: 5,
  },
  {
    title: (n) => `${n} board approves share buyback program`,
    source: "CNBC",
    daysAgo: 6,
  },
  {
    title: (n) => `Regulators open antitrust probe into ${n}`,
    source: "WSJ",
    daysAgo: 8,
  },
  {
    title: (n) => `${n} faces lawsuit over data practices`,
    source: "Reuters",
    daysAgo: 10,
  },
  {
    title: (n) => `${n} announces restructuring with job cuts`,
    source: "Bloomberg",
    daysAgo: 12,
  },
  {
    title: (n) => `${n} declares quarterly dividend`,
    source: "MarketWire",
    daysAgo: 14,
  },
];

/**
 * Commodities have no earnings or guidance, so they get supply/demand and
 * macro-flavoured headlines rather than the corporate stock templates.
 */
const COMMODITY_NEWS_TEMPLATES: ReadonlyArray<{
  title: (name: string) => string;
  source: string;
  daysAgo: number;
}> = [
  {
    title: (n) => `${n} climbs as the dollar weakens`,
    source: "Reuters",
    daysAgo: 1,
  },
  {
    title: (n) => `Supply disruption tightens the ${n} market`,
    source: "Bloomberg",
    daysAgo: 2,
  },
  {
    title: (n) => `Funds raise net long positioning in ${n}`,
    source: "Reuters",
    daysAgo: 3,
  },
  {
    title: (n) => `${n} inventories build more than expected`,
    source: "MarketWire",
    daysAgo: 4,
  },
  {
    title: (n) => `Demand outlook for ${n} softens on slower growth`,
    source: "FT",
    daysAgo: 6,
  },
  {
    title: (n) => `Analysts lift year-end ${n} forecast`,
    source: "Bloomberg",
    daysAgo: 8,
  },
];

const CRYPTO_NEWS_TEMPLATES: ReadonlyArray<{
  title: (name: string) => string;
  source: string;
  daysAgo: number;
}> = [
  {
    title: (n) => `${n} surges as institutional inflows hit record`,
    source: "CoinDesk",
    daysAgo: 1,
  },
  {
    title: (n) => `Regulators approve new ${n} ETF`,
    source: "The Block",
    daysAgo: 2,
  },
  {
    title: (n) => `${n} network completes major upgrade`,
    source: "Decrypt",
    daysAgo: 3,
  },
  {
    title: (n) => `Analysts raise ${n} price target on growth`,
    source: "CoinTelegraph",
    daysAgo: 4,
  },
  {
    title: (n) => `${n} partners with payments provider`,
    source: "CoinDesk",
    daysAgo: 6,
  },
  {
    title: (n) => `${n} drops as regulators warn on compliance`,
    source: "Reuters",
    daysAgo: 9,
  },
  {
    title: (n) => `Exchange halts ${n} withdrawals amid probe`,
    source: "The Block",
    daysAgo: 11,
  },
];

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Build a synthetic order book around a coin's fixture price.
 *
 * @param symbol - The coin ticker.
 * @returns Bid/ask levels, or `null` if the coin is unknown.
 */
export function getOrderBookFixture(
  symbol: string,
): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null {
  const c = getCryptoFixture(symbol);
  if (!c || c.price === null) return null;
  const mid = c.price;
  const tick = Math.max(0.0001, mid * 0.0001);
  const bids: OrderBookLevel[] = Array.from({ length: 12 }, (_, i) => ({
    price: round(mid - tick * (i + 1), 4),
    quantity: round(1 + i * 0.35, 3),
  }));
  const asks: OrderBookLevel[] = Array.from({ length: 12 }, (_, i) => ({
    price: round(mid + tick * (i + 1), 4),
    quantity: round(0.8 + i * 0.3, 3),
  }));
  return { bids, asks };
}

const FUTURES_FIXTURES: readonly FuturesQuote[] = [
  {
    symbol: "ES=F",
    name: "S&P 500 E-mini",
    price: 5462.5,
    changePct: 0.21,
    currency: "USD",
  },
  {
    symbol: "NQ=F",
    name: "Nasdaq 100 E-mini",
    price: 19850.25,
    changePct: 0.34,
    currency: "USD",
  },
  {
    symbol: "YM=F",
    name: "Dow E-mini",
    price: 39210,
    changePct: -0.12,
    currency: "USD",
  },
  {
    symbol: "CL=F",
    name: "Crude Oil",
    price: 81.45,
    changePct: -0.83,
    currency: "USD",
  },
  {
    symbol: "GC=F",
    name: "Gold",
    price: 2331.4,
    changePct: 0.45,
    currency: "USD",
  },
  {
    symbol: "SI=F",
    name: "Silver",
    price: 29.18,
    changePct: 0.62,
    currency: "USD",
  },
  {
    symbol: "NG=F",
    name: "Natural Gas",
    price: 2.74,
    changePct: -1.4,
    currency: "USD",
  },
  {
    symbol: "ZB=F",
    name: "30Y T-Bond",
    price: 118.31,
    changePct: 0.08,
    currency: "USD",
  },
];

/** Watchlist of futures symbols fetched live (and fixture data for each). */
export const FUTURES_SYMBOLS: readonly string[] = FUTURES_FIXTURES.map(
  (f) => f.symbol,
);

/**
 * Get the fixture futures watchlist.
 *
 * @returns A copy of the static futures quotes.
 */
export function getFuturesFixture(): FuturesQuote[] {
  return FUTURES_FIXTURES.map((f) => ({ ...f }));
}

/**
 * Build deterministic synthetic trailing returns for a symbol.
 *
 * @param symbol - The asset symbol.
 * @returns Plausible YTD/1Y/3Y/5Y percentage returns.
 */
export function getPerformanceFixture(symbol: string): PerformanceReturns {
  const seed = [...symbol.toUpperCase()].reduce(
    (a, c) => a + c.charCodeAt(0),
    0,
  );
  const v = (base: number, spread: number): number =>
    round(base + ((seed % spread) - spread / 2), 1);
  return {
    symbol: symbol.toUpperCase(),
    ytd: v(9, 30),
    oneY: v(16, 50),
    threeY: v(42, 120),
    fiveY: v(95, 220),
    asOf: new Date(0).toISOString(),
    fallback: true,
  };
}

/** Round a strike to a sensible step for the underlying price. */
function strikeStep(price: number): number {
  if (price >= 1000) return 50;
  if (price >= 200) return 10;
  if (price >= 50) return 5;
  return 1;
}

/**
 * Build a synthetic options chain (with an IV smile) for an underlying.
 *
 * @param symbol - The underlying ticker.
 * @param nowMs - Current time in ms since epoch.
 * @param expiration - Optional selected expiration (ISO date); defaults to first.
 * @returns The chain pieces (underlying price, expirations, calls, puts).
 */
export function getOptionsFixture(
  symbol: string,
  nowMs: number,
  expiration?: string,
): {
  underlyingPrice: number;
  expirations: string[];
  expiration: string;
  calls: OptionContract[];
  puts: OptionContract[];
} {
  const underlying = getStockFixture(symbol).price ?? 100;
  const expirations = [7, 14, 30, 60, 90].map((d) =>
    new Date(nowMs + d * 86_400_000).toISOString().slice(0, 10),
  );
  const selected =
    expiration && expirations.includes(expiration)
      ? expiration
      : (expirations[0] as string);

  const step = strikeStep(underlying);
  const atm = Math.round(underlying / step) * step;
  const calls: OptionContract[] = [];
  const puts: OptionContract[] = [];
  for (let k = -5; k <= 5; k++) {
    const strike = round(atm + k * step, 2);
    if (strike <= 0) continue;
    const iv = round(0.28 + 0.02 * Math.abs(k), 4);
    const callIntrinsic = Math.max(0, underlying - strike);
    const putIntrinsic = Math.max(0, strike - underlying);
    const timeValue = round(underlying * 0.01 + step * 0.2, 2);
    const vol = Math.max(1, 500 - Math.abs(k) * 80);
    const oi = Math.max(1, 2000 - Math.abs(k) * 300);
    calls.push({
      strike,
      lastPrice: round(callIntrinsic + timeValue, 2),
      impliedVolatility: iv,
      volume: vol,
      openInterest: oi,
      inTheMoney: strike < underlying,
    });
    puts.push({
      strike,
      lastPrice: round(putIntrinsic + timeValue, 2),
      impliedVolatility: iv,
      volume: Math.max(1, vol - 40),
      openInterest: Math.max(1, oi - 200),
      inTheMoney: strike > underlying,
    });
  }
  return {
    underlyingPrice: underlying,
    expirations,
    expiration: selected,
    calls,
    puts,
  };
}

/**
 * Get fixture raw news articles for an asset.
 *
 * Publication dates are anchored to `now` so the recency weighting behaves
 * realistically; pass a fixed `now` in tests for determinism.
 *
 * @param symbol - The asset symbol.
 * @param type - The asset class.
 * @param nowMs - Current time in ms since epoch.
 * @returns A list of raw articles.
 */
export function getNewsFixture(
  symbol: string,
  type: AssetType,
  nowMs: number,
): RawNewsArticle[] {
  const name = resolveAssetName(symbol);
  const templates =
    type === "crypto"
      ? CRYPTO_NEWS_TEMPLATES
      : type === "commodity"
        ? COMMODITY_NEWS_TEMPLATES
        : STOCK_NEWS_TEMPLATES;
  return templates.map((t, i) => ({
    id: `${symbol.toUpperCase()}-fx-${i}`,
    title: t.title(name),
    source: t.source,
    url: "https://example.com/news",
    publishedAt: new Date(nowMs - t.daysAgo * 86_400_000).toISOString(),
    summary: undefined,
  }));
}

/**
 * Generate deterministic fixture financial statements for a symbol.
 *
 * Figures are scaled from the stock fixture's implied revenue (market cap over
 * P/S) so different symbols produce different but plausible statements.
 *
 * @param symbol - The stock ticker.
 * @param frequency - Annual or quarterly periods.
 * @param nowMs - Current time in ms since epoch (anchors period labels).
 * @returns A fully-populated statements payload.
 */
export function getFinancialsFixture(
  symbol: string,
  frequency: StatementFrequency,
  nowMs: number,
): FinancialStatements {
  const f = getStockFixture(symbol);
  const annualRevenue =
    f.marketCap !== null && f.psRatio !== null && f.psRatio > 0
      ? f.marketCap / f.psRatio
      : 50_000_000_000;
  const margin = (f.netProfitMargin ?? 10) / 100;

  const periods = frequency === "annual" ? 5 : 6;
  const now = new Date(nowMs);
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;

  const income: StatementPeriod[] = [];
  const balance: StatementPeriod[] = [];
  const cashflow: StatementPeriod[] = [];

  for (let i = periods - 1; i >= 0; i--) {
    let label: string;
    let date: string;
    let revenue: number;
    if (frequency === "annual") {
      const y = year - 1 - i;
      label = String(y);
      date = `${y}-12-31`;
      revenue = annualRevenue / Math.pow(1.08, i + 1);
    } else {
      // Walk back i quarters from the previous (last completed) quarter.
      const qIndex = year * 4 + (quarter - 2) - i;
      const qy = Math.floor(qIndex / 4);
      const q = (qIndex % 4) + 1;
      label = `Q${q} '${String(qy).slice(2)}`;
      date = `${qy}-${String(q * 3).padStart(2, "0")}-28`;
      revenue = annualRevenue / 4 / Math.pow(1.02, i + 1);
    }

    const grossProfit = revenue * 0.42;
    const operatingIncome = revenue * (margin + 0.04);
    const netIncome = revenue * margin;
    income.push({
      date,
      label,
      values: {
        totalRevenue: revenue,
        costOfRevenue: revenue - grossProfit,
        grossProfit,
        operatingExpense: grossProfit - operatingIncome,
        operatingIncome,
        pretaxIncome: netIncome * 1.18,
        taxProvision: netIncome * 0.18,
        netIncome,
        EBITDA: operatingIncome * 1.2,
        dilutedAverageShares: 1_000_000_000,
        dilutedEPS: netIncome / 1_000_000_000,
      },
    });
    balance.push({
      date,
      label,
      values: {
        totalAssets: revenue * 1.8,
        currentAssets: revenue * 0.6,
        cashAndCashEquivalents: revenue * 0.25,
        totalLiabilitiesNetMinorityInterest: revenue * 1.1,
        currentLiabilities: revenue * 0.45,
        totalDebt: revenue * 0.5,
        stockholdersEquity: revenue * 0.7,
        workingCapital: revenue * 0.15,
      },
    });
    cashflow.push({
      date,
      label,
      values: {
        operatingCashFlow: netIncome * 1.25,
        investingCashFlow: -revenue * 0.1,
        financingCashFlow: -netIncome * 0.4,
        capitalExpenditure: -revenue * 0.08,
        freeCashFlow: netIncome * 1.25 - revenue * 0.08,
        endCashPosition: revenue * 0.25,
      },
    });
  }

  return {
    symbol: symbol.toUpperCase(),
    frequency,
    income,
    balance,
    cashflow,
    asOf: new Date(nowMs).toISOString(),
  };
}
