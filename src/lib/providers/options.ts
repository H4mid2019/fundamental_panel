import YahooFinance from "yahoo-finance2";
import { z } from "zod";

import { resolveAssetType } from "../assets";
import { features } from "../env";
import { getOptionsFixture } from "../fixtures";
import { logger } from "../logger";
import {
  err,
  ok,
  type AppError,
  type OptionContract,
  type OptionsChain,
  type Result,
} from "../types";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const MAX_STRIKES = 21;

const ContractSchema = z.object({
  strike: z.number().finite(),
  lastPrice: z.number().finite().optional(),
  impliedVolatility: z.number().finite().optional(),
  volume: z.number().finite().optional(),
  openInterest: z.number().finite().optional(),
  inTheMoney: z.boolean().optional(),
});

const DateLike = z.union([z.date(), z.number(), z.string()]);

const OptionsResultSchema = z.object({
  expirationDates: z.array(DateLike).optional(),
  quote: z
    .object({ regularMarketPrice: z.number().finite().optional() })
    .optional(),
  options: z
    .array(
      z.object({
        expirationDate: DateLike.optional(),
        calls: z.array(ContractSchema).optional(),
        puts: z.array(ContractSchema).optional(),
      }),
    )
    .optional(),
});

export const optionsSchemas = { ContractSchema, OptionsResultSchema };

/** Normalize a Date/number(seconds)/string into a `YYYY-MM-DD` string. */
function toIsoDate(value: Date | number | string | undefined): string | null {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number")
    return new Date(value * 1000).toISOString().slice(0, 10);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

function mapContract(c: z.infer<typeof ContractSchema>): OptionContract {
  return {
    strike: c.strike,
    lastPrice: c.lastPrice ?? null,
    impliedVolatility: c.impliedVolatility ?? null,
    volume: c.volume ?? null,
    openInterest: c.openInterest ?? null,
    inTheMoney: c.inTheMoney ?? false,
  };
}

/** Keep the `MAX_STRIKES` strikes closest to the underlying price. */
function windowStrikes(
  contracts: OptionContract[],
  underlying: number | null,
): OptionContract[] {
  const sorted = [...contracts].sort((a, b) => a.strike - b.strike);
  if (underlying === null || sorted.length <= MAX_STRIKES) return sorted;
  let nearest = 0;
  let best = Infinity;
  sorted.forEach((c, i) => {
    const d = Math.abs(c.strike - underlying);
    if (d < best) {
      best = d;
      nearest = i;
    }
  });
  const half = Math.floor(MAX_STRIKES / 2);
  const start = Math.max(
    0,
    Math.min(nearest - half, sorted.length - MAX_STRIKES),
  );
  return sorted.slice(start, start + MAX_STRIKES);
}

/** Put/call ratio by open interest (falls back to volume). */
function putCallRatio(
  calls: OptionContract[],
  puts: OptionContract[],
): number | null {
  const sum = (arr: OptionContract[], k: "openInterest" | "volume") =>
    arr.reduce((a, c) => a + (c[k] ?? 0), 0);
  const callOi = sum(calls, "openInterest") || sum(calls, "volume");
  const putOi = sum(puts, "openInterest") || sum(puts, "volume");
  if (callOi <= 0) return null;
  return Math.round((putOi / callOi) * 100) / 100;
}

function assemble(
  symbol: string,
  underlyingPrice: number | null,
  expirations: string[],
  expiration: string,
  calls: OptionContract[],
  puts: OptionContract[],
  nowMs: number,
  fallback: boolean,
): OptionsChain {
  const windowedCalls = windowStrikes(calls, underlyingPrice);
  const windowedPuts = windowStrikes(puts, underlyingPrice);
  return {
    symbol: symbol.toUpperCase(),
    underlyingPrice,
    expirations,
    expiration,
    calls: windowedCalls,
    puts: windowedPuts,
    putCallRatio: putCallRatio(windowedCalls, windowedPuts),
    asOf: new Date(nowMs).toISOString(),
    fallback,
  };
}

function fixtureChain(
  symbol: string,
  expiration: string | undefined,
  nowMs: number,
): OptionsChain {
  const fx = getOptionsFixture(symbol, nowMs, expiration);
  return assemble(
    symbol,
    fx.underlyingPrice,
    fx.expirations,
    fx.expiration,
    fx.calls,
    fx.puts,
    nowMs,
    true,
  );
}

/**
 * Fetch an options chain for a stock or index from Yahoo, with fixture fallback.
 *
 * @param symbol - The underlying ticker.
 * @param expiration - Optional expiration (ISO date) to fetch.
 * @returns A {@link Result} that resolves to the options chain.
 */
export async function getOptionsChain(
  symbol: string,
  expiration?: string,
): Promise<Result<OptionsChain, AppError>> {
  if (resolveAssetType(symbol) === "crypto") {
    return err({
      code: "NOT_FOUND",
      message: "Options are not available for crypto",
    });
  }

  const now = Date.now();
  if (features.forceFixtures) return ok(fixtureChain(symbol, expiration, now));
  try {
    const query = expiration ? { date: new Date(expiration) } : {};
    const raw: unknown = await yahooFinance.options(symbol, query);
    const parsed = OptionsResultSchema.safeParse(raw);
    const chain = parsed.success ? parsed.data.options?.[0] : undefined;
    if (!parsed.success || !chain)
      return ok(fixtureChain(symbol, expiration, now));

    const expirations = (parsed.data.expirationDates ?? [])
      .map(toIsoDate)
      .filter((d): d is string => d !== null);
    const selected = toIsoDate(chain.expirationDate) ?? expirations[0] ?? "";

    return ok(
      assemble(
        symbol,
        parsed.data.quote?.regularMarketPrice ?? null,
        expirations,
        selected,
        (chain.calls ?? []).map(mapContract),
        (chain.puts ?? []).map(mapContract),
        now,
        false,
      ),
    );
  } catch (error) {
    logger.warn("yahoo.options failed; using fixture", { symbol, error });
    return ok(fixtureChain(symbol, expiration, now));
  }
}
