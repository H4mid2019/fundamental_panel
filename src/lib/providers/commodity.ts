import { z } from "zod";

import { resolveAssetName, resolveCommodityCategory } from "../assets";
import { features } from "../env";
import { computePriceAction } from "../indicators/priceAction";
import { logger } from "../logger";
import {
  ok,
  type AppError,
  type CommodityFundamentals,
  type Result,
} from "../types";

import { getCandles } from "./candles";
import { yahooFinance } from "./yahoo";

/** Daily bars pulled to compute the 200-day average and 52-week range. */
const DAILY_BARS = 400;

/** The few quote fields we need; futures expose no fundamentals. */
const QuoteSchema = z.object({
  shortName: z.string().optional(),
  longName: z.string().optional(),
  regularMarketPrice: z.number().finite().optional(),
  regularMarketChangePercent: z.number().finite().optional(),
  currency: z.string().optional(),
});

export const commoditySchemas = { QuoteSchema };

/**
 * Fetch a commodity's price-action profile.
 *
 * Futures carry no company fundamentals, so this builds the profile from daily
 * Yahoo candles (realized volatility, 200-day trend, 52-week range, RSI) and
 * layers a live quote on top for the headline price. Always resolves: the
 * candle provider degrades to deterministic fixtures, so the panel still
 * renders when upstream is unavailable.
 *
 * @param symbol - The Yahoo futures symbol (e.g. `GC=F`).
 * @returns A {@link Result} with normalized commodity fundamentals.
 */
export async function getCommodityFundamentals(
  symbol: string,
): Promise<Result<CommodityFundamentals, AppError>> {
  const upper = symbol.toUpperCase();

  // Daily candles drive every derived metric (never throws; may be fixtures).
  const series = await getCandles("yahoo", upper, "1d", DAILY_BARS);
  const action = computePriceAction(series.candles);

  const lastBar = series.candles[series.candles.length - 1];
  const prevBar = series.candles[series.candles.length - 2];
  const candleClose = lastBar?.close ?? null;
  const candleChangePct =
    lastBar && prevBar && prevBar.close > 0
      ? Math.round((lastBar.close / prevBar.close - 1) * 1000) / 10
      : null;

  let quote: z.infer<typeof QuoteSchema> | null = null;
  if (!features.forceFixtures) {
    try {
      const raw: unknown = await yahooFinance.quote(upper);
      const parsed = QuoteSchema.safeParse(raw);
      if (parsed.success) quote = parsed.data;
    } catch (error) {
      logger.warn("commodity.quote failed; using candles", { symbol, error });
    }
  }

  return ok({
    symbol: upper,
    name: quote?.shortName ?? quote?.longName ?? resolveAssetName(upper),
    price: quote?.regularMarketPrice ?? candleClose,
    currency: quote?.currency ?? "USD",
    changePct: quote?.regularMarketChangePercent ?? candleChangePct,
    category: resolveCommodityCategory(upper),
    ...action,
  });
}
