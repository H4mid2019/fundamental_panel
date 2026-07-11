/**
 * The risk-free rate used by every Black-Scholes call.
 *
 * `^IRX` — the 13-week T-bill — is the right point on the curve. The obvious
 * alternative, `^TNX`, is the 10-year yield, and option tenors here run 14 to
 * 365 days; discounting a 40-day option at a 10-year rate is simply the wrong
 * maturity. Yahoo quotes both in **percent**, so the value is divided by 100.
 *
 * When the rate cannot be fetched the scan never stops: it falls back to the
 * configured constant, logs a warning, and reports `fallback: true` so every
 * metric row computed with it can be flagged `rates_fallback` and the UI can say
 * the delta is approximate. A wrong-but-confident number is worse than a
 * flagged one.
 */

import { z } from "zod";

import { cached } from "../../cache";
import { features } from "../../env";
import { logger } from "../../logger";
import { yahooFinance } from "../../providers/yahoo";
import { getHedgeConfig } from "../config";

/** Where a rate came from, and whether it is real. */
export interface RiskFreeRate {
  /** Continuously-compounded rate as a decimal (0.03695 = 3.695%). */
  rate: number;
  source: "irx" | "tnx" | "fixed";
  /** True when the live quote was unavailable and the fallback was used. */
  fallback: boolean;
}

const QuoteSchema = z.object({
  regularMarketPrice: z.number().finite().optional(),
});

/** Yahoo's ticker for each supported curve point. */
const SYMBOLS: Record<"irx" | "tnx", string> = {
  irx: "^IRX", // 13-week T-bill — the right maturity for option tenors
  tnx: "^TNX", // 10-year note
};

/** Rates move slowly; one fetch per day is plenty. */
const TTL_SECONDS = 12 * 60 * 60;

/** A plausible band for a short-term rate. Outside it, the quote is garbage. */
const MIN_RATE = 0;
const MAX_RATE = 0.25;

/**
 * Fetch the risk-free rate, falling back to the configured constant.
 *
 * @param now - Capture instant, used only to key the daily cache.
 * @returns The rate and whether it is a fallback. Never throws.
 */
export async function getRiskFreeRate(
  now: Date = new Date(),
): Promise<RiskFreeRate> {
  const { source, fallbackRate } = getHedgeConfig().metrics.riskFreeRate;

  const asFallback: RiskFreeRate = {
    rate: fallbackRate,
    source: "fixed",
    fallback: true,
  };

  if (source === "fixed") {
    return { rate: fallbackRate, source: "fixed", fallback: false };
  }
  if (features.forceFixtures) return asFallback;

  const symbol = SYMBOLS[source];
  const key = `hedge:rate:${symbol}:${now.toISOString().slice(0, 10)}`;

  const rate = await cached<number | null>(key, TTL_SECONDS, async () => {
    try {
      const raw: unknown = await yahooFinance.quote(
        symbol,
        {},
        { validateResult: false },
      );
      const parsed = QuoteSchema.safeParse(raw);
      const percent = parsed.success
        ? parsed.data.regularMarketPrice
        : undefined;
      if (percent === undefined) return null;

      // Yahoo quotes yields in percent: 3.695 means 3.695%.
      const decimal = percent / 100;
      if (decimal < MIN_RATE || decimal > MAX_RATE) {
        logger.warn("hedge.rates: implausible rate; ignoring", {
          symbol,
          percent,
        });
        return null;
      }
      return decimal;
    } catch (error) {
      logger.warn("hedge.rates: fetch failed", {
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  });

  if (rate === null) {
    logger.warn("hedge.rates: using fallback rate; deltas will be flagged", {
      symbol,
      fallbackRate,
    });
    return asFallback;
  }

  return { rate, source, fallback: false };
}
