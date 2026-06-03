import { resolveAssetName, resolveAssetType } from "./assets";
import { getCached, setCached } from "./cache";
import { getCryptoFixture, getStockFixture } from "./fixtures";
import { buildCryptoIndicators } from "./indicators/crypto";
import { buildStockIndicators } from "./indicators/stock";
import { logger } from "./logger";
import { getCryptoFundamentals } from "./providers/coingecko";
import { getStockMetrics } from "./providers/finnhub";
import { getStockFundamentals } from "./providers/fmp";
import { getIndexFundamentals, getYahooFundamentals } from "./providers/yahoo";
import {
  err,
  ok,
  type AppError,
  type AssetSnapshot,
  type CryptoFundamentals,
  type IndicatorSet,
  type Result,
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
    type === "stock" ? await enrichWithFinnhub(symbol, data) : data;

  await setCached(cacheKey, enriched, FUNDAMENTALS_TTL_SECONDS);
  return enriched;
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
