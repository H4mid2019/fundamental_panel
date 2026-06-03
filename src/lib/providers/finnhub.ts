import { z } from "zod";

import { env, features } from "../env";
import { getNewsFixture, type RawNewsArticle } from "../fixtures";
import { fetchJson } from "../http";
import {
  ok,
  type AppError,
  type AssetType,
  type Result,
  type StockFundamentals,
} from "../types";

const BASE_URL = "https://finnhub.io/api/v1";
const LOOKBACK_DAYS = 14;
const MAX_ARTICLES = 50;

/** Coerce an unknown value into a finite number or `null`. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Subset of fundamentals Finnhub's `/stock/metric` can supply. */
export type FinnhubMetrics = Partial<
  Pick<
    StockFundamentals,
    | "peRatio"
    | "pbRatio"
    | "psRatio"
    | "pegRatio"
    | "evToEbitda"
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
    | "revenueGrowthYoY"
    | "beta"
    | "assetTurnover"
  >
>;

const MetricSchema = z.object({
  metric: z.record(z.string(), z.unknown()),
});

export const finnhubMetricSchema = MetricSchema;

/**
 * Map a validated Finnhub `metric` object to normalized fundamentals.
 *
 * Finnhub already expresses ratios in percent, so no fraction conversion is
 * applied (unlike FMP).
 *
 * @param m - The validated `metric` record.
 * @returns A partial fundamentals object.
 */
export function mapFinnhubMetrics(m: Record<string, unknown>): FinnhubMetrics {
  const pick = (...keys: string[]): number | null => {
    for (const k of keys) {
      const n = num(m[k]);
      if (n !== null) return n;
    }
    return null;
  };
  return {
    peRatio: pick("peTTM", "peAnnual"),
    pbRatio: pick("pbQuarterly", "pbAnnual"),
    psRatio: pick("psTTM", "psAnnual"),
    pegRatio: pick("pegRatio", "pegTTM"),
    evToEbitda: pick("currentEv/ebitdaTTM", "currentEv/ebitdaAnnual"),
    dividendYield: pick(
      "dividendYieldIndicatedAnnual",
      "currentDividendYieldTTM",
    ),
    payoutRatio: pick("payoutRatioTTM", "payoutRatioAnnual"),
    eps: pick("epsTTM", "epsAnnual"),
    roe: pick("roeTTM", "roeAnnual"),
    roa: pick("roaTTM", "roaAnnual"),
    netProfitMargin: pick("netProfitMarginTTM", "netProfitMarginAnnual"),
    currentRatio: pick("currentRatioQuarterly", "currentRatioAnnual"),
    quickRatio: pick("quickRatioQuarterly", "quickRatioAnnual"),
    debtToEquity: pick(
      "totalDebt/totalEquityQuarterly",
      "totalDebt/totalEquityAnnual",
      "longTermDebt/equityQuarterly",
    ),
    interestCoverage: pick(
      "netInterestCoverageTTM",
      "netInterestCoverageAnnual",
    ),
    revenueGrowthYoY: pick("revenueGrowthTTMYoy", "revenueGrowthQuarterlyYoy"),
    beta: pick("beta"),
    assetTurnover: pick("assetTurnoverTTM", "assetTurnoverAnnual"),
  };
}

/**
 * Fetch fundamentals metrics from Finnhub (covers symbols FMP's free plan gates).
 *
 * @param symbol - The stock ticker.
 * @returns A {@link Result} with a partial fundamentals object (empty when
 *   Finnhub is unconfigured or in fixture mode).
 */
export async function getStockMetrics(
  symbol: string,
): Promise<Result<FinnhubMetrics, AppError>> {
  if (features.forceFixtures || !features.finnhub) return ok({});
  const url = `${BASE_URL}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${env.FINNHUB_API_KEY}`;
  const result = await fetchJson<unknown>(url);
  if (!result.ok) return result;
  const parsed = MetricSchema.safeParse(result.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Finnhub metric failed validation",
      },
    };
  }
  return ok(mapFinnhubMetrics(parsed.data.metric));
}

const ArticleSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  headline: z.string(),
  source: z.string().optional(),
  url: z.string().optional(),
  datetime: z.number().optional(),
  summary: z.string().optional(),
});

const ArticlesSchema = z.array(ArticleSchema);

export const finnhubSchemas = { ArticleSchema, ArticlesSchema };

/** Format a timestamp as `YYYY-MM-DD` (UTC) for Finnhub's date range. */
function toDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Map validated Finnhub articles into the shared raw-article shape.
 *
 * @param raw - Validated Finnhub article array.
 * @returns Normalized raw articles (deduped by URL/title, capped).
 */
export function mapFinnhub(
  raw: z.infer<typeof ArticlesSchema>,
): RawNewsArticle[] {
  const seen = new Set<string>();
  const out: RawNewsArticle[] = [];
  for (const a of raw) {
    const key = a.url || a.headline;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: String(a.id ?? key),
      title: a.headline,
      source: a.source ?? "Finnhub",
      url: a.url ?? "",
      publishedAt: a.datetime
        ? new Date(a.datetime * 1000).toISOString()
        : new Date().toISOString(),
      summary: a.summary,
    });
    if (out.length >= MAX_ARTICLES) break;
  }
  return out;
}

/**
 * Fetch raw news articles for an asset from Finnhub.
 *
 * Stocks use the company-news endpoint; indexes and crypto use category news.
 * Falls back to deterministic fixtures when no API key is configured.
 *
 * @param symbol - The asset symbol.
 * @param type - The asset class.
 * @param nowMs - Current time in ms since epoch.
 * @returns A {@link Result} with raw articles.
 */
export async function getNewsArticles(
  symbol: string,
  type: AssetType,
  nowMs: number,
): Promise<Result<RawNewsArticle[], AppError>> {
  if (features.forceFixtures || !features.finnhub) {
    return ok(getNewsFixture(symbol, type, nowMs));
  }

  const token = env.FINNHUB_API_KEY;
  const url =
    type === "stock"
      ? `${BASE_URL}/company-news?symbol=${encodeURIComponent(symbol)}` +
        `&from=${toDate(nowMs - LOOKBACK_DAYS * 86_400_000)}&to=${toDate(nowMs)}&token=${token}`
      : `${BASE_URL}/news?category=${type === "crypto" ? "crypto" : "general"}&token=${token}`;

  const result = await fetchJson<unknown>(url);
  if (!result.ok) return result;
  const parsed = ArticlesSchema.safeParse(result.data);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Finnhub news failed validation",
      },
    };
  }
  return ok(mapFinnhub(parsed.data));
}
