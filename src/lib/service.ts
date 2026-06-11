import { resolveAssetName, resolveAssetType } from "./assets";
import { getCached, setCached } from "./cache";
import { getCryptoFixture, getStockFixture } from "./fixtures";
import { buildCryptoIndicators } from "./indicators/crypto";
import { buildStockIndicators } from "./indicators/stock";
import { logger } from "./logger";
import { buildPeerGroups, type PeerInput } from "./peers";
import { getCryptoFundamentals } from "./providers/coingecko";
import { getFinancialStatements } from "./providers/financials";
import { getStockMetrics } from "./providers/finnhub";
import { getStockFundamentals } from "./providers/fmp";
import { getRecommendedPeers, getQuoteStats } from "./providers/peers";
import { getIndexFundamentals, getYahooFundamentals } from "./providers/yahoo";
import {
  err,
  ok,
  type AppError,
  type AssetSnapshot,
  type CryptoFundamentals,
  type FinancialStatements,
  type IndicatorSet,
  type PeerBenchmarks,
  type Result,
  type StatementFrequency,
  type StockFundamentals,
} from "./types";

const FUNDAMENTALS_TTL_SECONDS = 5 * 60;

/** Load stock/index fundamentals with caching and fixture resilience. */
async function loadStockFundamentals(
  symbol: string,
): Promise<StockFundamentals> {
  const type = resolveAssetType(symbol);
  const cacheKey = `fund:${type}:${symbol.toUpperCase()}`;
  const cachedValue = await getCached<StockFundamentals>(cacheKey);
  if (cachedValue) return cachedValue;

  let data: StockFundamentals;
  if (type === "index") {
    const result = await getIndexFundamentals(symbol);
    data = result.ok ? result.data : getStockFixture(symbol);
  } else {
    // Yahoo is the primary fundamentals source (broad & free, incl. FCF/EBITDA);
    // FMP is the fallback when Yahoo is unavailable.
    const yahoo = await getYahooFundamentals(symbol);
    if (yahoo.ok) {
      data = yahoo.data;
    } else {
      const fmp = await getStockFundamentals(symbol);
      if (fmp.ok) {
        data = fmp.data;
      } else {
        logger.warn("service.stock fundamentals fell back to fixture", {
          symbol,
          error: fmp.error,
        });
        data = getStockFixture(symbol);
      }
    }
  }

  // Backfill any remaining gaps (e.g. asset turnover, interest coverage) from
  // Finnhub's broad free coverage.
  const enriched =
    type === "stock"
      ? deriveValuationRatios(await enrichWithFinnhub(symbol, data))
      : data;

  await setCached(cacheKey, enriched, FUNDAMENTALS_TTL_SECONDS);
  return enriched;
}

/**
 * Derive valuation ratios providers withhold for loss-making companies.
 *
 * Most sources omit P/E (and PEG) when trailing earnings are negative, which
 * would surface as N/A; a negative ratio is more informative, so compute P/E
 * from price / EPS when possible.
 *
 * @param f - Enriched fundamentals.
 * @returns Fundamentals with derived ratios filled in where still missing.
 */
export function deriveValuationRatios(f: StockFundamentals): StockFundamentals {
  if (f.peRatio !== null || f.price === null || !f.eps) return f;
  return { ...f, peRatio: Math.round((f.price / f.eps) * 100) / 100 };
}

/** Fill missing ratio/metric fields from Finnhub when FMP didn't supply them. */
async function enrichWithFinnhub(
  symbol: string,
  data: StockFundamentals,
): Promise<StockFundamentals> {
  const fillable = [
    data.peRatio,
    data.pbRatio,
    data.psRatio,
    data.pegRatio,
    data.evToEbitda,
    data.dividendYield,
    data.payoutRatio,
    data.eps,
    data.roe,
    data.roa,
    data.netProfitMargin,
    data.currentRatio,
    data.quickRatio,
    data.debtToEquity,
    data.interestCoverage,
    data.revenueGrowthYoY,
    data.beta,
    data.assetTurnover,
  ];
  if (!fillable.some((v) => v === null)) return data;

  const result = await getStockMetrics(symbol);
  if (!result.ok) {
    logger.warn("service.finnhub metric enrichment failed", {
      symbol,
      error: result.error,
    });
    return data;
  }
  const m = result.data;
  const fill = (
    a: number | null,
    b: number | null | undefined,
  ): number | null => a ?? b ?? null;
  return {
    ...data,
    peRatio: fill(data.peRatio, m.peRatio),
    pbRatio: fill(data.pbRatio, m.pbRatio),
    psRatio: fill(data.psRatio, m.psRatio),
    pegRatio: fill(data.pegRatio, m.pegRatio),
    evToEbitda: fill(data.evToEbitda, m.evToEbitda),
    dividendYield: fill(data.dividendYield, m.dividendYield),
    payoutRatio: fill(data.payoutRatio, m.payoutRatio),
    eps: fill(data.eps, m.eps),
    roe: fill(data.roe, m.roe),
    roa: fill(data.roa, m.roa),
    netProfitMargin: fill(data.netProfitMargin, m.netProfitMargin),
    currentRatio: fill(data.currentRatio, m.currentRatio),
    quickRatio: fill(data.quickRatio, m.quickRatio),
    debtToEquity: fill(data.debtToEquity, m.debtToEquity),
    interestCoverage: fill(data.interestCoverage, m.interestCoverage),
    revenueGrowthYoY: fill(data.revenueGrowthYoY, m.revenueGrowthYoY),
    beta: fill(data.beta, m.beta),
    assetTurnover: fill(data.assetTurnover, m.assetTurnover),
  };
}

/** Load crypto fundamentals with caching and fixture resilience. */
async function loadCryptoFundamentals(
  symbol: string,
): Promise<Result<CryptoFundamentals, AppError>> {
  const cacheKey = `fund:crypto:${symbol.toUpperCase()}`;
  const cachedValue = await getCached<CryptoFundamentals>(cacheKey);
  if (cachedValue) return ok(cachedValue);

  const result = await getCryptoFundamentals(symbol);
  if (result.ok) {
    await setCached(cacheKey, result.data, FUNDAMENTALS_TTL_SECONDS);
    return result;
  }

  const fixture = getCryptoFixture(symbol);
  if (fixture) {
    logger.warn("service.crypto fundamentals fell back to fixture", {
      symbol,
      error: result.error,
    });
    await setCached(cacheKey, fixture, FUNDAMENTALS_TTL_SECONDS);
    return ok(fixture);
  }
  return err(result.error);
}

/**
 * Build the headline snapshot for an asset.
 *
 * @param symbol - The asset symbol.
 * @returns A {@link Result} with the asset snapshot.
 */
export async function getAssetSnapshot(
  symbol: string,
): Promise<Result<AssetSnapshot, AppError>> {
  const type = resolveAssetType(symbol);
  const asOf = new Date().toISOString();

  if (type === "crypto") {
    const result = await loadCryptoFundamentals(symbol);
    if (!result.ok) return err(result.error);
    const f = result.data;
    return ok({
      symbol: f.symbol,
      name: f.name,
      type,
      price: f.price,
      currency: f.currency,
      changePct: f.changePct,
      marketCap: f.marketCap,
      meta: f.rank !== null ? `Rank #${f.rank}` : undefined,
      asOf,
    });
  }

  const f = await loadStockFundamentals(symbol);
  return ok({
    symbol: f.symbol,
    name: f.name || resolveAssetName(symbol),
    type,
    price: f.price,
    currency: f.currency,
    changePct: f.changePct,
    marketCap: f.marketCap,
    meta: f.sector ?? undefined,
    asOf,
  });
}

const PEERS_TTL_SECONDS = 15 * 60;
const FINANCIALS_TTL_SECONDS = 6 * 60 * 60;

/**
 * Load financial statements with caching (statements change at most quarterly).
 *
 * @param symbol - The stock symbol.
 * @param frequency - Annual or quarterly periods.
 * @returns A {@link Result} with the normalized statements.
 */
export async function getFinancials(
  symbol: string,
  frequency: StatementFrequency,
): Promise<Result<FinancialStatements, AppError>> {
  const type = resolveAssetType(symbol);
  if (type !== "stock") {
    return err({
      code: "NOT_FOUND",
      message: "Financial statements are only available for stocks",
    });
  }

  const cacheKey = `fin:${symbol.toUpperCase()}:${frequency}`;
  const cachedValue = await getCached<FinancialStatements>(cacheKey);
  if (cachedValue) return ok(cachedValue);

  const result = await getFinancialStatements(symbol, frequency);
  if (!result.ok) return result;

  await setCached(cacheKey, result.data, FINANCIALS_TTL_SECONDS);
  return result;
}

/**
 * Lightweight peer fundamentals: Yahoo only (no Finnhub enrichment, to keep a
 * 5-peer comparison from burning the Finnhub rate budget), cached separately
 * from the main fundamentals path, fixture-backed in fixture mode.
 */
async function loadPeerFundamentals(
  symbol: string,
): Promise<StockFundamentals | null> {
  const cacheKey = `fund:peer:${symbol.toUpperCase()}`;
  const cachedValue = await getCached<StockFundamentals>(cacheKey);
  if (cachedValue) return cachedValue;

  const result = await getYahooFundamentals(symbol);
  if (!result.ok) {
    logger.warn("service.peer fundamentals unavailable", {
      symbol,
      error: result.error,
    });
    return null;
  }
  const data = deriveValuationRatios(result.data);
  await setCached(cacheKey, data, FUNDAMENTALS_TTL_SECONDS);
  return data;
}

/**
 * Build the peer-benchmark comparison (asset vs peer median vs sector avg).
 *
 * Peers come from Yahoo's "similar stocks"; each peer's fundamentals are
 * fetched from Yahoo and the comparison rows are grouped into the five tabs
 * the UI renders. Only meaningful for stocks.
 *
 * @param symbol - The stock symbol.
 * @returns A {@link Result} with the peer benchmarks.
 */
export async function getPeerBenchmarks(
  symbol: string,
): Promise<Result<PeerBenchmarks, AppError>> {
  const type = resolveAssetType(symbol);
  if (type !== "stock") {
    return err({
      code: "NOT_FOUND",
      message: "Peer benchmarks are only available for stocks",
    });
  }

  const cacheKey = `peers:${symbol.toUpperCase()}`;
  const cachedValue = await getCached<PeerBenchmarks>(cacheKey);
  if (cachedValue) return ok(cachedValue);

  const self = await loadStockFundamentals(symbol);
  const peersResult = await getRecommendedPeers(symbol);
  const peerSymbols = peersResult.ok ? peersResult.data : [];

  const [stats, ...peerFunds] = await Promise.all([
    getQuoteStats([self.symbol, ...peerSymbols]),
    ...peerSymbols.map((p) => loadPeerFundamentals(p)),
  ]);

  const peers: PeerInput[] = peerFunds
    .filter((f): f is StockFundamentals => f !== null)
    .map((f) => ({ fundamentals: f, stats: stats[f.symbol] }));

  const data: PeerBenchmarks = {
    symbol: self.symbol,
    peers: peers.map((p) => ({
      symbol: p.fundamentals.symbol,
      name: p.fundamentals.name,
    })),
    groups: buildPeerGroups(
      { fundamentals: self, stats: stats[self.symbol] },
      peers,
    ),
    asOf: new Date().toISOString(),
    fallback: !peersResult.ok || peers.length === 0,
  };

  await setCached(cacheKey, data, PEERS_TTL_SECONDS);
  return ok(data);
}

/**
 * Build the full indicator set for an asset.
 *
 * @param symbol - The asset symbol.
 * @returns A {@link Result} with the indicator set.
 */
export async function getIndicatorSet(
  symbol: string,
): Promise<Result<IndicatorSet, AppError>> {
  const type = resolveAssetType(symbol);
  const asOf = new Date().toISOString();

  if (type === "crypto") {
    const result = await loadCryptoFundamentals(symbol);
    if (!result.ok) return err(result.error);
    return ok({
      symbol: result.data.symbol,
      assetType: type,
      asOf,
      indicators: buildCryptoIndicators(result.data),
    });
  }

  const f = await loadStockFundamentals(symbol);
  return ok({
    symbol: f.symbol,
    assetType: type,
    asOf,
    indicators: buildStockIndicators(f),
  });
}
