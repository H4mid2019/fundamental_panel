/**
 * Per-ticker underlying data: daily candles, the dividend schedule, and the
 * continuous dividend yield `q` that Black-Scholes needs.
 *
 * All of it comes from a single `chart(..., { events: "div" })` call. The candles
 * are needed anyway for the 200-day MA, RSI, realized vol and EWMA, so the real
 * dividend history rides along at **zero extra API cost** — which matters when
 * the universe is 85 tickers and Yahoo rate-limits.
 *
 * ── The dividend-yield trap ────────────────────────────────────────────────────
 * Yahoo exposes several dividend fields and they disagree with each other. For
 * TLT: `trailingAnnualDividendYield` = 2.55% but `summaryDetail.yield` = 4.53%.
 * The trailing field under-reports ETF distributions, and TLT/HYG/LQD/XLU are
 * precisely the names where `q` moves delta materially — so the "obvious" field
 * is the wrong one.
 *
 * The field that is consistent across ETFs *and* stocks is `quote.dividendYield`
 * (in percent). Verified against the actual cash flows: TLT pays $0.318 monthly
 * on a $84.47 spot = 4.52%, matching it and refuting the trailing field. NVDA
 * confirms it from the other side — it recently raised its dividend, and
 * `quote.dividendYield` reflects the new rate while `trailingAnnualDividendRate`
 * still shows the old one.
 *
 * Where a real dividend schedule is available we prefer it outright, since it is
 * built from observed cash flows rather than Yahoo's opinion, and cross-check the
 * quoted yield against it.
 */

import { z } from "zod";

import { cached } from "../../cache";
import type { Candle } from "../../chart/types";
import { features } from "../../env";
import { logger } from "../../logger";
import { yahooFinance } from "../../providers/yahoo";
import { err, ok, type AppError, type Result } from "../../types";
import { toIsoDate } from "../expiry";

/** One observed dividend payment. */
export interface DividendEvent {
  /** Ex-dividend date, `YYYY-MM-DD`. */
  exDate: string;
  /** Amount per share, in the underlying's currency. */
  amount: number;
}

/**
 * A ticker's dividend profile.
 *
 * `nextExDate`/`nextAmount` are *projections* from the observed cadence, not
 * announcements. That is the only way to get an ex-div date for an ETF at all:
 * Yahoo's `calendarEvents` throws for ETFs, yet SPY and TLT pay distributions and
 * carry real early-assignment risk on a short call.
 */
export interface DividendProfile {
  /** Continuous dividend yield for Black-Scholes, or `null` when unknown. */
  q: number | null;
  /** True when `q` was unavailable and 0 was substituted. */
  fallback: boolean;
  /** Observed payments, ascending by ex-date. */
  history: DividendEvent[];
  /** Median days between recent payments; `null` with fewer than two. */
  cadenceDays: number | null;
  /** Projected next ex-dividend date, `YYYY-MM-DD`, or `null`. */
  nextExDate: string | null;
  /** Projected next payment amount, or `null`. */
  nextAmount: number | null;
}

/** Everything the metrics engine needs about an underlying, besides its chain. */
export interface UnderlyingData {
  ticker: string;
  spot: number | null;
  /** Daily candles, ascending. */
  candles: Candle[];
  dividends: DividendProfile;
  fallback: boolean;
}

const DividendSchema = z.object({
  date: z.union([z.date(), z.number(), z.string()]),
  amount: z.number().finite(),
});

const ChartSchema = z.object({
  meta: z
    .object({ regularMarketPrice: z.number().finite().optional() })
    .optional(),
  quotes: z.array(
    z.object({
      date: z.union([z.date(), z.number(), z.string()]),
      open: z.number().finite().nullable().optional(),
      high: z.number().finite().nullable().optional(),
      low: z.number().finite().nullable().optional(),
      close: z.number().finite().nullable().optional(),
      volume: z.number().finite().nullable().optional(),
    }),
  ),
  events: z
    .object({ dividends: z.array(DividendSchema).optional() })
    .optional(),
});

const QuoteSchema = z.object({
  regularMarketPrice: z.number().finite().optional(),
  /** In PERCENT (4.53 = 4.53%). The one field consistent across ETFs and stocks. */
  dividendYield: z.number().finite().optional(),
});

export const underlyingSchemas = { ChartSchema, QuoteSchema, DividendSchema };

/** A dividend yield above this is a data error, not a security. */
const MAX_YIELD = 0.25;

const toDate = (v: Date | number | string): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") return new Date(v * 1000);
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/** Median of a numeric list; `null` when empty. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : null;
}

/**
 * Convert a simple annual dividend yield into the continuous rate `q` that
 * Black-Scholes assumes.
 *
 * The quoted yield is a simple annual figure (dividends over price). Black-Scholes
 * discounts the underlying by `e^{-qT}`, which is a *continuously* compounded
 * rate, so the consistent conversion is `1 + y = e^q`. The difference is small
 * (5.9% simple becomes 5.73% continuous) but it is free to be right, and on a
 * long-dated collar on HYG it is not nothing.
 *
 * @param simpleYield - Simple annual yield as a decimal (0.059 = 5.9%).
 * @returns The continuously-compounded equivalent.
 */
export function toContinuousYield(simpleYield: number): number {
  return Math.log1p(simpleYield);
}

/**
 * Build a dividend profile from observed payments plus the quoted yield.
 *
 * Prefers the observed cash flows — `amount x paymentsPerYear / spot` — because
 * they are what actually happened. Falls back to the quoted yield when there is
 * no usable history, and to zero (flagged) when there is neither.
 *
 * @param history - Observed payments, ascending by ex-date.
 * @param quotedYieldPct - Yahoo's `quote.dividendYield`, in percent.
 * @param spot - Current underlying price.
 * @param now - Capture instant, for projecting the next ex-date.
 * @returns The profile, with `q` continuously compounded.
 */
export function buildDividendProfile(
  history: readonly DividendEvent[],
  quotedYieldPct: number | undefined,
  spot: number | null,
  now: Date,
): DividendProfile {
  const recent = history.slice(-8);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    const cur = recent[i];
    if (!prev || !cur) continue;
    const days = Math.round(
      (Date.parse(cur.exDate) - Date.parse(prev.exDate)) / 86_400_000,
    );
    if (days > 0) gaps.push(days);
  }
  const cadenceDays = median(gaps);
  const last = recent[recent.length - 1];

  // Project the next ex-div from the observed cadence. Roll forward if the
  // projection is already in the past (a payment we have not seen yet).
  let nextExDate: string | null = null;
  if (last && cadenceDays !== null && cadenceDays > 0) {
    let next = Date.parse(last.exDate) + cadenceDays * 86_400_000;
    const nowMs = now.getTime();
    for (let guard = 0; next < nowMs && guard < 24; guard += 1) {
      next += cadenceDays * 86_400_000;
    }
    nextExDate = toIsoDate(new Date(next));
  }

  // q from observed cash flows, which beats any quoted field.
  const perYear =
    cadenceDays !== null && cadenceDays > 0 ? 365 / cadenceDays : null;
  const observed =
    last && perYear !== null && spot !== null && spot > 0
      ? (last.amount * perYear) / spot
      : null;

  const quoted =
    quotedYieldPct !== undefined && Number.isFinite(quotedYieldPct)
      ? quotedYieldPct / 100
      : null;

  const simple = observed ?? quoted;
  const usable = simple !== null && simple >= 0 && simple <= MAX_YIELD;

  return {
    q: usable ? toContinuousYield(simple) : null,
    fallback: !usable,
    history: [...history],
    cadenceDays,
    nextExDate,
    nextAmount: last?.amount ?? null,
  };
}

/** How far back to pull candles: enough for the 756-day correlation regime band. */
const LOOKBACK_DAYS = 3 * 365 + 30;

/** Candles and dividends change once a day; a scan pair should share one fetch. */
const TTL_SECONDS = 6 * 60 * 60;

/**
 * Fetch candles, dividends and the dividend yield for one underlying.
 *
 * @param ticker - The underlying.
 * @param now - Capture instant.
 * @returns The underlying data, or an {@link AppError}. Never throws.
 */
export async function getUnderlying(
  ticker: string,
  now: Date = new Date(),
): Promise<Result<UnderlyingData, AppError>> {
  if (features.forceFixtures) {
    return err({
      code: "NOT_FOUND",
      message: `${ticker}: underlying data unavailable in fixture mode`,
    });
  }

  const key = `hedge:underlying:${ticker}:${toIsoDate(now)}`;
  const data = await cached<UnderlyingData | null>(key, TTL_SECONDS, () =>
    fetchUnderlying(ticker, now),
  );

  if (!data) {
    return err({ code: "NOT_FOUND", message: `${ticker}: no underlying data` });
  }
  return ok(data);
}

/** One chart call (candles + dividends) plus one quote call (spot + yield). */
async function fetchUnderlying(
  ticker: string,
  now: Date,
): Promise<UnderlyingData | null> {
  const period1 = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);

  let candles: Candle[] = [];
  let dividends: DividendEvent[] = [];
  let chartSpot: number | null = null;

  try {
    const raw: unknown = await yahooFinance.chart(
      ticker,
      { period1, period2: now, interval: "1d", events: "div" },
      { validateResult: false },
    );
    const parsed = ChartSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn("hedge.underlying: chart failed schema validation", {
        ticker,
      });
      return null;
    }

    chartSpot = parsed.data.meta?.regularMarketPrice ?? null;

    candles = parsed.data.quotes
      .map((q) => {
        const date = toDate(q.date);
        if (
          !date ||
          q.open == null ||
          q.high == null ||
          q.low == null ||
          q.close == null
        ) {
          return null;
        }
        return {
          time: Math.floor(date.getTime() / 1000),
          open: q.open,
          high: q.high,
          low: q.low,
          close: q.close,
          volume: q.volume ?? null,
        } satisfies Candle;
      })
      .filter((c): c is Candle => c !== null)
      .sort((a, b) => a.time - b.time);

    dividends = (parsed.data.events?.dividends ?? [])
      .map((d) => {
        const date = toDate(d.date);
        if (!date || d.amount <= 0) return null;
        return { exDate: toIsoDate(date), amount: d.amount };
      })
      .filter((d): d is DividendEvent => d !== null)
      .sort((a, b) => a.exDate.localeCompare(b.exDate));
  } catch (error) {
    logger.warn("hedge.underlying: chart fetch failed", {
      ticker,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (candles.length === 0) {
    logger.warn("hedge.underlying: no candles; skipping", { ticker });
    return null;
  }

  // The quoted yield is only a *fallback* for q — but it is the one Yahoo field
  // that is consistent between ETFs and stocks, so it is worth the call for
  // tickers whose dividend history is empty or too short to infer a cadence.
  let quotedYieldPct: number | undefined;
  let quoteSpot: number | null = null;
  try {
    const raw: unknown = await yahooFinance.quote(
      ticker,
      {},
      { validateResult: false },
    );
    const parsed = QuoteSchema.safeParse(raw);
    if (parsed.success) {
      quotedYieldPct = parsed.data.dividendYield;
      quoteSpot = parsed.data.regularMarketPrice ?? null;
    }
  } catch (error) {
    logger.debug("hedge.underlying: quote fetch failed; yield may fall back", {
      ticker,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const spot =
    quoteSpot ?? chartSpot ?? candles[candles.length - 1]?.close ?? null;

  return {
    ticker: ticker.toUpperCase(),
    spot,
    candles,
    dividends: buildDividendProfile(dividends, quotedYieldPct, spot, now),
    fallback: false,
  };
}
