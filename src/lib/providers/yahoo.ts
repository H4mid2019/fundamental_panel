import YahooFinance from "yahoo-finance2";
import { z } from "zod";

import { resolveAssetName, SUPPORTED_ASSETS } from "../assets";
import { features } from "../env";
import {
  FUTURES_SYMBOLS,
  getFuturesFixture,
  getStockFixture,
} from "../fixtures";
import { logger } from "../logger";
import {
  err,
  ok,
  type AppError,
  type AssetRef,
  type AssetType,
  type FuturesQuote,
  type Result,
  type StockFundamentals,
} from "../types";

/** Subset of the Yahoo quote payload we consume, validated defensively. */
const QuoteSchema = z.object({
  shortName: z.string().optional(),
  longName: z.string().optional(),
  regularMarketPrice: z.number().finite().optional(),
  currency: z.string().optional(),
  regularMarketChangePercent: z.number().finite().optional(),
  trailingPE: z.number().finite().optional(),
  marketCap: z.number().finite().optional(),
});

export const yahooSchemas = { QuoteSchema };

// yahoo-finance2 v3 exposes a class that must be instantiated; suppress its
// one-time interactive survey notice in server contexts.
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

/**
 * Fetch index fundamentals via Yahoo Finance, layered over a fixture baseline.
 *
 * Indexes expose very few fundamentals, so this enriches the deterministic
 * fixture with whatever live quote fields are available, and falls back to the
 * pure fixture if the upstream call fails or returns an unexpected shape. The
 * result is always `ok` so indexes render reliably.
 *
 * @param symbol - The index symbol (e.g. `^GSPC`).
 * @returns A {@link Result} that always resolves to normalized fundamentals.
 */
export async function getIndexFundamentals(
  symbol: string,
): Promise<Result<StockFundamentals, AppError>> {
  const base = getStockFixture(symbol);
  if (features.forceFixtures) return ok(base);
  try {
    // The library's return type is a large discriminated union; validate the
    // few fields we need from the raw payload instead of depending on it.
    const raw: unknown = await yahooFinance.quote(symbol);
    const parsed = QuoteSchema.safeParse(raw);
    if (!parsed.success) return ok(base);
    const q = parsed.data;
    return ok({
      ...base,
      name: q.shortName ?? q.longName ?? base.name,
      price: q.regularMarketPrice ?? base.price,
      currency: q.currency ?? base.currency,
      changePct: q.regularMarketChangePercent ?? base.changePct,
      peRatio: q.trailingPE ?? base.peRatio,
      marketCap: q.marketCap ?? base.marketCap,
    });
  } catch (error) {
    logger.warn("yahoo.quote failed; using fixture", { symbol, error });
    return ok(base);
  }
}

const YNum = z.number().finite().nullish();

/** quoteSummary modules we read for fundamentals (validated defensively). */
const FundamentalsSchema = z.object({
  price: z
    .object({
      regularMarketPrice: YNum,
      regularMarketChangePercent: YNum,
      currency: z.string().nullish(),
      longName: z.string().nullish(),
      shortName: z.string().nullish(),
      marketCap: YNum,
    })
    .nullish(),
  summaryDetail: z
    .object({
      trailingPE: YNum,
      priceToSalesTrailing12Months: YNum,
      dividendYield: YNum,
      payoutRatio: YNum,
      marketCap: YNum,
    })
    .nullish(),
  defaultKeyStatistics: z
    .object({
      priceToBook: YNum,
      pegRatio: YNum,
      enterpriseToEbitda: YNum,
      trailingEps: YNum,
      beta: YNum,
    })
    .nullish(),
  financialData: z
    .object({
      returnOnEquity: YNum,
      returnOnAssets: YNum,
      profitMargins: YNum,
      revenueGrowth: YNum,
      currentRatio: YNum,
      quickRatio: YNum,
      debtToEquity: YNum,
      freeCashflow: YNum,
    })
    .nullish(),
  assetProfile: z.object({ sector: z.string().nullish() }).nullish(),
});

export const yahooFundamentalsSchema = FundamentalsSchema;

const numOrNull = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** Yahoo expresses ratios like ROE as fractions; convert to percent. */
const toPct = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : round1(v * 100);

/**
 * Fetch full stock fundamentals from Yahoo `quoteSummary` (free, broad coverage
 * including free cash flow and EBITDA). Falls back to fixtures in fixture mode.
 *
 * @param symbol - The stock ticker.
 * @returns A {@link Result} with normalized fundamentals.
 */
export async function getYahooFundamentals(
  symbol: string,
): Promise<Result<StockFundamentals, AppError>> {
  if (features.forceFixtures) return ok(getStockFixture(symbol));
  try {
    const raw: unknown = await yahooFinance.quoteSummary(symbol, {
      modules: [
        "price",
        "summaryDetail",
        "defaultKeyStatistics",
        "financialData",
        "assetProfile",
      ],
    });
    const parsed = FundamentalsSchema.safeParse(raw);
    if (!parsed.success) {
      return err({
        code: "VALIDATION_ERROR",
        message: "Yahoo fundamentals failed validation",
      });
    }
    const p = parsed.data.price ?? {};
    const s = parsed.data.summaryDetail ?? {};
    const k = parsed.data.defaultKeyStatistics ?? {};
    const f = parsed.data.financialData ?? {};
    const a = parsed.data.assetProfile ?? {};

    const price = numOrNull(p.regularMarketPrice);
    const marketCap = numOrNull(p.marketCap) ?? numOrNull(s.marketCap);
    if (price === null && marketCap === null) {
      return err({ code: "NOT_FOUND", message: `No Yahoo data for ${symbol}` });
    }
    const de = numOrNull(f.debtToEquity);

    return ok({
      symbol: symbol.toUpperCase(),
      name: p.longName ?? p.shortName ?? resolveAssetName(symbol),
      price,
      currency: p.currency ?? "USD",
      changePct: toPct(p.regularMarketChangePercent),
      sector: a.sector ?? null,
      marketCap,
      beta: numOrNull(k.beta),
      peRatio: numOrNull(s.trailingPE),
      pbRatio: numOrNull(k.priceToBook),
      psRatio: numOrNull(s.priceToSalesTrailing12Months),
      pegRatio: numOrNull(k.pegRatio),
      evToEbitda: numOrNull(k.enterpriseToEbitda),
      dividendYield: toPct(s.dividendYield),
      payoutRatio: toPct(s.payoutRatio),
      eps: numOrNull(k.trailingEps),
      roe: toPct(f.returnOnEquity),
      roa: toPct(f.returnOnAssets),
      netProfitMargin: toPct(f.profitMargins),
      currentRatio: numOrNull(f.currentRatio),
      quickRatio: numOrNull(f.quickRatio),
      // Yahoo reports debt/equity as a percent (e.g. 79.5 → 0.80x).
      debtToEquity: de === null ? null : round2(de / 100),
      interestCoverage: null, // not in these modules; Finnhub backfills it
      freeCashFlow: numOrNull(f.freeCashflow),
      revenueGrowthYoY: toPct(f.revenueGrowth),
      assetTurnover: null, // not in these modules; Finnhub backfills it
    });
  } catch (error) {
    logger.warn("yahoo.quoteSummary failed", { symbol, error });
    return err({
      code: "PROVIDER_ERROR",
      message: "Yahoo fundamentals failed",
    });
  }
}

const SearchSchema = z.object({
  quotes: z.array(
    z.object({
      symbol: z.string().optional(),
      shortname: z.string().optional(),
      longname: z.string().optional(),
      quoteType: z.string().optional(),
    }),
  ),
});

export const searchSchemas = { SearchSchema };

function mapQuoteType(quoteType: string | undefined): AssetType | null {
  switch ((quoteType ?? "").toUpperCase()) {
    case "EQUITY":
    case "ETF":
    case "MUTUALFUND":
      return "stock";
    case "INDEX":
      return "index";
    default:
      return null;
  }
}

/** Filter the curated registry by a query (symbol or name substring). */
function curatedMatches(query: string): AssetRef[] {
  const q = query.toLowerCase();
  return SUPPORTED_ASSETS.filter(
    (a) =>
      a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
  );
}

/**
 * Search for assets by ticker or company name via Yahoo, with a curated
 * fallback. Always resolves (never throws); crypto is served from the curated
 * list so symbols stay app-native (e.g. `BTC`, not `BTC-USD`).
 *
 * @param query - The search text.
 * @returns Up to 12 matching {@link AssetRef} entries.
 */
export async function getSymbolSearch(query: string): Promise<AssetRef[]> {
  const q = query.trim();
  if (!q) return [];
  const curated = curatedMatches(q);
  if (features.forceFixtures) return curated.slice(0, 12);

  try {
    const raw: unknown = await yahooFinance.search(q);
    const parsed = SearchSchema.safeParse(raw);
    if (!parsed.success) return curated.slice(0, 12);

    const live: AssetRef[] = [];
    for (const quote of parsed.data.quotes) {
      const type = mapQuoteType(quote.quoteType);
      if (!type || !quote.symbol) continue;
      live.push({
        symbol: quote.symbol.toUpperCase(),
        name: quote.shortname ?? quote.longname ?? quote.symbol,
        type,
      });
    }

    // Merge live results with curated crypto matches, de-duplicated by symbol.
    const cryptoMatches = curated.filter((a) => a.type === "crypto");
    const seen = new Set<string>();
    const merged = [...live, ...cryptoMatches].filter((a) => {
      const key = a.symbol.toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return (merged.length > 0 ? merged : curated).slice(0, 12);
  } catch (error) {
    logger.warn("yahoo.search failed; using curated list", { query: q, error });
    return curated.slice(0, 12);
  }
}

const FuturesQuoteSchema = z.object({
  symbol: z.string(),
  shortName: z.string().optional(),
  regularMarketPrice: z.number().finite().optional(),
  regularMarketChangePercent: z.number().finite().optional(),
  currency: z.string().optional(),
});

const FuturesArraySchema = z.array(FuturesQuoteSchema);

export const futuresSchemas = { FuturesQuoteSchema };

/**
 * Fetch the futures watchlist quotes via Yahoo, falling back to fixtures.
 *
 * @returns A {@link Result} that always resolves to the futures quotes.
 */
export async function getFuturesQuotes(): Promise<
  Result<FuturesQuote[], AppError>
> {
  const fixtures = getFuturesFixture();
  if (features.forceFixtures) return ok(fixtures);
  try {
    const raw: unknown = await yahooFinance.quote([...FUTURES_SYMBOLS]);
    const parsed = FuturesArraySchema.safeParse(raw);
    if (!parsed.success) return ok(fixtures);
    const bySymbol = new Map(parsed.data.map((q) => [q.symbol, q]));
    return ok(
      fixtures.map((fx) => {
        const q = bySymbol.get(fx.symbol);
        return {
          symbol: fx.symbol,
          name: q?.shortName ?? fx.name,
          price: q?.regularMarketPrice ?? fx.price,
          changePct: q?.regularMarketChangePercent ?? fx.changePct,
          currency: q?.currency ?? fx.currency,
        };
      }),
    );
  } catch (error) {
    logger.warn("yahoo.futures failed; using fixture", { error });
    return ok(fixtures);
  }
}
