import { z } from "zod";

import { CRYPTO_IDS, TOP_CRYPTO_FALLBACK } from "../assets";
import { env, features } from "../env";
import { getCryptoFixture } from "../fixtures";
import { fetchJson } from "../http";
import { logger } from "../logger";
import {
  err,
  ok,
  type AppError,
  type AssetRef,
  type CryptoFundamentals,
  type Result,
} from "../types";

const BASE_URL = "https://api.coingecko.com/api/v3";

const NullableNumber = z.number().finite().nullish();

const MarketSchema = z.array(
  z.object({
    id: z.string(),
    symbol: z.string(),
    name: z.string(),
    current_price: NullableNumber,
    market_cap: NullableNumber,
    market_cap_rank: NullableNumber,
    fully_diluted_valuation: NullableNumber,
    total_volume: NullableNumber,
    circulating_supply: NullableNumber,
    total_supply: NullableNumber,
    price_change_percentage_24h: NullableNumber,
    price_change_percentage_30d_in_currency: NullableNumber,
  }),
);

const MarketChartSchema = z.object({
  prices: z.array(z.tuple([z.number(), z.number()])),
});

export const coingeckoSchemas = { MarketSchema, MarketChartSchema };

/** Coerce an unknown value into a finite number or `null`. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Compute annualized 30-day volatility (percent) from a price series.
 *
 * @param prices - Array of `[timestamp, price]` tuples.
 * @returns Annualized volatility in percent, or `null` if insufficient data.
 */
export function computeVolatility(
  prices: ReadonlyArray<readonly [number, number]>,
): number | null {
  if (prices.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]?.[1];
    const curr = prices[i]?.[1];
    if (prev && curr && prev > 0) returns.push(Math.log(curr / prev));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const annualized = Math.sqrt(variance) * Math.sqrt(365) * 100;
  return Math.round(annualized * 10) / 10;
}

function headers(): HeadersInit | undefined {
  return env.COINGECKO_API_KEY
    ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY }
    : undefined;
}

/**
 * Map a validated CoinGecko market entry into {@link CryptoFundamentals}.
 *
 * @param symbol - The requested ticker (e.g. `BTC`).
 * @param market - One validated market record.
 * @param volatility30d - Pre-computed 30d volatility, or `null`.
 * @returns Normalized crypto fundamentals.
 */
export function mapCoinGecko(
  symbol: string,
  market: z.infer<typeof MarketSchema>[number],
  volatility30d: number | null,
): CryptoFundamentals {
  const marketCap = num(market.market_cap);
  const totalVolume = num(market.total_volume);
  const nvtRatio =
    marketCap !== null && totalVolume && totalVolume > 0
      ? Math.round((marketCap / totalVolume) * 10) / 10
      : null;
  return {
    symbol: symbol.toUpperCase(),
    name: market.name,
    price: num(market.current_price),
    currency: "USD",
    changePct: num(market.price_change_percentage_24h),
    rank: num(market.market_cap_rank),
    marketCap,
    fullyDilutedValuation: num(market.fully_diluted_valuation),
    totalVolume,
    circulatingSupply: num(market.circulating_supply),
    totalSupply: num(market.total_supply),
    volatility30d,
    nvtRatio,
    priceChange30dPct: num(market.price_change_percentage_30d_in_currency),
  };
}

/**
 * Fetch normalized crypto fundamentals from CoinGecko.
 *
 * @param symbol - The coin ticker (e.g. `BTC`).
 * @returns A {@link Result} with normalized fundamentals.
 */
export async function getCryptoFundamentals(
  symbol: string,
): Promise<Result<CryptoFundamentals, AppError>> {
  const id = CRYPTO_IDS[symbol.toUpperCase()];
  if (!id) {
    return err({ code: "NOT_FOUND", message: `Unsupported coin: ${symbol}` });
  }
  if (features.forceFixtures || !features.coingecko) {
    const fixture = getCryptoFixture(symbol);
    return fixture
      ? ok(fixture)
      : err({ code: "NOT_FOUND", message: `No fixture for ${symbol}` });
  }

  const marketUrl =
    `${BASE_URL}/coins/markets?vs_currency=usd&ids=${id}` +
    `&price_change_percentage=30d`;
  const market = await fetchJson<unknown>(marketUrl, {
    init: { headers: headers() },
  });
  if (!market.ok) return market;
  const parsed = MarketSchema.safeParse(market.data);
  if (!parsed.success || parsed.data.length === 0) {
    return err({
      code: "VALIDATION_ERROR",
      message: `CoinGecko market response for ${id} failed validation`,
    });
  }

  const chartUrl = `${BASE_URL}/coins/${id}/market_chart?vs_currency=usd&days=30&interval=daily`;
  const chart = await fetchJson<unknown>(chartUrl, {
    init: { headers: headers() },
  });
  let volatility30d: number | null = null;
  if (chart.ok) {
    const chartParsed = MarketChartSchema.safeParse(chart.data);
    if (chartParsed.success) {
      volatility30d = computeVolatility(chartParsed.data.prices);
    }
  } else {
    logger.warn("coingecko.chart failed", { symbol, error: chart.error });
  }

  const entry = parsed.data[0];
  if (!entry) {
    return err({ code: "NOT_FOUND", message: `No data for ${symbol}` });
  }
  return ok(mapCoinGecko(symbol, entry, volatility30d));
}

/**
 * Fetch the live top-5 coins by market cap, falling back to a hardcoded list.
 *
 * @returns An array of exactly five {@link AssetRef} entries.
 */
export async function getTopCryptos(): Promise<AssetRef[]> {
  if (features.forceFixtures || !features.coingecko)
    return [...TOP_CRYPTO_FALLBACK];
  const url = `${BASE_URL}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=5&page=1`;
  const result = await fetchJson<unknown>(url, {
    init: { headers: headers() },
  });
  if (!result.ok) return [...TOP_CRYPTO_FALLBACK];
  const parsed = MarketSchema.safeParse(result.data);
  if (!parsed.success) return [...TOP_CRYPTO_FALLBACK];
  return parsed.data.map((c) => ({
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    type: "crypto" as const,
  }));
}
