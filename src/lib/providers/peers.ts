import { z } from "zod";

import { features } from "../env";
import { logger } from "../logger";
import { err, ok, type AppError, type Result } from "../types";

import { yahooFinance } from "./yahoo";

/** Maximum number of peers compared against the selected asset. */
export const MAX_PEERS = 5;

/** Deterministic peer list used in fixture mode (filtered for the self symbol). */
const FIXTURE_PEERS = ["AAPL", "MSFT", "GOOGL", "TSLA", "AMZN", "NVDA"];

const RecommendationsSchema = z.object({
  recommendedSymbols: z.array(
    z.object({ symbol: z.string(), score: z.number().optional() }),
  ),
});

export const peersSchemas = { RecommendationsSchema };

/**
 * Fetch Yahoo's "similar stocks" recommendations for a symbol.
 *
 * @param symbol - The stock ticker.
 * @returns A {@link Result} with up to {@link MAX_PEERS} peer tickers.
 */
export async function getRecommendedPeers(
  symbol: string,
): Promise<Result<string[], AppError>> {
  const self = symbol.toUpperCase();
  if (features.forceFixtures) {
    return ok(FIXTURE_PEERS.filter((p) => p !== self).slice(0, MAX_PEERS));
  }
  try {
    const raw: unknown = await yahooFinance.recommendationsBySymbol(symbol);
    const parsed = RecommendationsSchema.safeParse(raw);
    if (!parsed.success) {
      return err({
        code: "VALIDATION_ERROR",
        message: "Yahoo recommendations failed validation",
      });
    }
    const peers = parsed.data.recommendedSymbols
      .map((r) => r.symbol.toUpperCase())
      .filter((p) => p !== self)
      .slice(0, MAX_PEERS);
    return ok(peers);
  } catch (error) {
    logger.warn("yahoo.recommendationsBySymbol failed", { symbol, error });
    return err({ code: "PROVIDER_ERROR", message: "Yahoo peers failed" });
  }
}

/** Quote-derived stats not present in the normalized fundamentals shape. */
export interface QuoteStats {
  /** Current price as a percentage of the 52-week high. */
  pctOf52wHigh: number | null;
  /** Trailing 1-year price change, in percent. */
  oneYearChangePct: number | null;
}

const QuoteStatsSchema = z.object({
  symbol: z.string(),
  regularMarketPrice: z.number().finite().optional(),
  fiftyTwoWeekHigh: z.number().finite().optional(),
  // Already expressed in percent (e.g. 318.29 for +318%).
  fiftyTwoWeekChangePercent: z.number().finite().optional(),
});

const QuoteStatsArraySchema = z.array(QuoteStatsSchema);

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Fetch 52-week stats for a batch of symbols via Yahoo `quote`.
 *
 * Failures degrade to an empty map so the peer comparison still renders the
 * fundamentals-based rows.
 *
 * @param symbols - The tickers to look up.
 * @returns Stats keyed by upper-cased symbol.
 */
export async function getQuoteStats(
  symbols: string[],
): Promise<Record<string, QuoteStats>> {
  if (symbols.length === 0 || features.forceFixtures) return {};
  try {
    const raw: unknown = await yahooFinance.quote(symbols);
    const parsed = QuoteStatsArraySchema.safeParse(raw);
    if (!parsed.success) return {};
    const out: Record<string, QuoteStats> = {};
    for (const q of parsed.data) {
      const price = q.regularMarketPrice;
      const high = q.fiftyTwoWeekHigh;
      out[q.symbol.toUpperCase()] = {
        pctOf52wHigh:
          price !== undefined && high !== undefined && high > 0
            ? round1((price / high) * 100)
            : null,
        oneYearChangePct:
          q.fiftyTwoWeekChangePercent !== undefined
            ? round1(q.fiftyTwoWeekChangePercent)
            : null,
      };
    }
    return out;
  } catch (error) {
    logger.warn("yahoo.quote peer stats failed", { symbols, error });
    return {};
  }
}
