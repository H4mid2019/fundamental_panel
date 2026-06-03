import { z } from "zod";

import { env, features } from "../env";
import { getStockFixture } from "../fixtures";
import { fetchJson } from "../http";
import { logger } from "../logger";
import {
  err,
  ok,
  type AppError,
  type Result,
  type StockFundamentals,
} from "../types";

// FMP retired the legacy /api/v3 endpoints for keys issued after Aug 2025;
// the current product is the "stable" API (query-param style, renamed fields).
const BASE_URL = "https://financialmodelingprep.com/stable";

type Row = Record<string, unknown>;

/** Coerce an unknown value into a finite number or `null`. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** First finite number found among candidate keys (handles FMP renames). */
function pick(row: Row | undefined, ...keys: string[]): number | null {
  if (!row) return null;
  for (const key of keys) {
    const n = num(row[key]);
    if (n !== null) return n;
  }
  return null;
}

/** First non-empty string found among candidate keys. */
function pickStr(row: Row | undefined, ...keys: string[]): string | undefined {
  if (!row) return undefined;
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

// Responses are arrays of flat objects; validate that shape and read fields
// defensively so we tolerate FMP's frequent field renames across API versions.
const RowsSchema = z.array(z.record(z.string(), z.unknown()));

export const fmpSchemas = { RowsSchema };

/** Convert a fraction (e.g. 0.123) to a percent (12.3), preserving null. */
function toPercent(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 10;
}

interface RawBundle {
  profile: Row[];
  ratios: Row[];
  keyMetrics: Row[];
  growth: Row[];
}

/**
 * Map validated FMP payloads into normalized {@link StockFundamentals}.
 *
 * Field names are looked up against both the current "stable" API and the
 * legacy v3 names so the mapper is robust to FMP's renames.
 *
 * @param symbol - The requested ticker.
 * @param raw - The validated FMP response bundle.
 * @returns Normalized fundamentals.
 */
export function mapFmp(symbol: string, raw: RawBundle): StockFundamentals {
  const p = raw.profile[0];
  // Ratio/metric fields live across two endpoints; merge for a single lookup.
  const m: Row = { ...(raw.keyMetrics[0] ?? {}), ...(raw.ratios[0] ?? {}) };
  const g = raw.growth[0];

  const marketCap =
    pick(p, "marketCap", "mktCap") ?? pick(m, "marketCap", "marketCapTTM");
  const price = pick(p, "price");
  const fcfPerShare = pick(m, "freeCashFlowPerShareTTM");
  const shares = marketCap !== null && price ? marketCap / price : null;

  return {
    symbol: symbol.toUpperCase(),
    name: pickStr(p, "companyName", "name") ?? symbol.toUpperCase(),
    price,
    currency: pickStr(p, "currency") ?? "USD",
    changePct: pick(p, "changePercentage", "changes", "change"),
    sector: pickStr(p, "sector") ?? null,
    marketCap,
    beta: pick(p, "beta"),
    peRatio: pick(m, "priceToEarningsRatioTTM", "peRatioTTM"),
    pbRatio: pick(m, "priceToBookRatioTTM"),
    psRatio: pick(m, "priceToSalesRatioTTM"),
    pegRatio: pick(
      m,
      "priceToEarningsGrowthRatioTTM",
      "priceEarningsToGrowthRatioTTM",
      "pegRatioTTM",
    ),
    evToEbitda: pick(
      m,
      "evToEBITDATTM",
      "enterpriseValueOverEBITDATTM",
      "evToEbitdaTTM",
    ),
    dividendYield: toPercent(pick(m, "dividendYieldTTM", "dividendYielTTM")),
    payoutRatio: toPercent(pick(m, "dividendPayoutRatioTTM", "payoutRatioTTM")),
    eps: pick(m, "netIncomePerShareTTM", "epsTTM", "eps"),
    roe: toPercent(pick(m, "returnOnEquityTTM")),
    roa: toPercent(pick(m, "returnOnAssetsTTM")),
    netProfitMargin: toPercent(pick(m, "netProfitMarginTTM")),
    currentRatio: pick(m, "currentRatioTTM"),
    quickRatio: pick(m, "quickRatioTTM"),
    debtToEquity: pick(m, "debtToEquityRatioTTM", "debtEquityRatioTTM"),
    interestCoverage: pick(
      m,
      "interestCoverageRatioTTM",
      "interestCoverageTTM",
    ),
    freeCashFlow:
      fcfPerShare !== null && shares !== null ? fcfPerShare * shares : null,
    revenueGrowthYoY: toPercent(pick(g, "growthRevenue")),
    assetTurnover: pick(m, "assetTurnoverTTM"),
  };
}

async function fetchRows(
  endpoint: string,
  symbol: string,
  extraQuery = "",
): Promise<Result<Row[], AppError>> {
  const url =
    `${BASE_URL}/${endpoint}?symbol=${encodeURIComponent(symbol)}` +
    `${extraQuery}&apikey=${env.FMP_API_KEY}`;
  const result = await fetchJson<unknown>(url);
  if (!result.ok) return result;
  const parsed = RowsSchema.safeParse(result.data);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: `FMP response for ${endpoint} failed validation`,
    });
  }
  return ok(parsed.data);
}

/**
 * Fetch normalized stock fundamentals from Financial Modeling Prep (stable API).
 *
 * Falls back to deterministic fixtures when no API key is configured. When a
 * key is present but the upstream call fails, an error result is returned so
 * the caller can decide how to degrade.
 *
 * @param symbol - The stock ticker (e.g. `AAPL`).
 * @returns A {@link Result} with normalized fundamentals.
 */
export async function getStockFundamentals(
  symbol: string,
): Promise<Result<StockFundamentals, AppError>> {
  if (features.forceFixtures || !features.fmp) {
    return ok(getStockFixture(symbol));
  }

  const [profile, ratios, keyMetrics, growth] = await Promise.all([
    fetchRows("profile", symbol),
    fetchRows("ratios-ttm", symbol),
    fetchRows("key-metrics-ttm", symbol),
    fetchRows("income-statement-growth", symbol, "&limit=1"),
  ]);

  // Profile is required; the statement endpoints are often gated on FMP's free
  // plan, so degrade them to empty (fields become N/A) rather than failing.
  if (!profile.ok) return profile;
  if (profile.data.length === 0) {
    logger.warn("fmp.empty profile", { symbol });
    return err({ code: "NOT_FOUND", message: `Unknown symbol: ${symbol}` });
  }

  const soft = (label: string, r: Result<Row[], AppError>): Row[] => {
    if (r.ok) return r.data;
    logger.warn("fmp.partial; endpoint unavailable", {
      symbol,
      endpoint: label,
      error: r.error,
    });
    return [];
  };

  return ok(
    mapFmp(symbol, {
      profile: profile.data,
      ratios: soft("ratios-ttm", ratios),
      keyMetrics: soft("key-metrics-ttm", keyMetrics),
      growth: soft("income-statement-growth", growth),
    }),
  );
}
