/**
 * `YahooChainProvider` — full option-chain snapshots on top of `yahoo-finance2`.
 *
 * This does not reuse `providers/options.ts::getOptionsChain`. That function is
 * built for the `/` options panel and windows the chain to the 21 strikes nearest
 * spot, which is right for an IV-smile chart and fatal here: a 25-delta put on a
 * 30-day tenor sits well outside a 21-strike window on most names, so the strike
 * search would come back empty or, worse, silently clamp to the window edge.
 * Widening that function would have changed what `/` renders, so this provider
 * goes to Yahoo directly — but reuses the same shared, notice-suppressed client.
 *
 * Sharp edges this handles, all observed live:
 *  - Yahoo returns exactly ONE expiration's chain per HTTP call. A snapshot of
 *    three tenors is four calls (one to list expirations, three to fetch), so the
 *    per-ticker call budget is the length of `chain.targetDte`.
 *  - Yahoo will 429 an aggressive scan. Hence bounded retries with exponential
 *    backoff and jitter, plus a server-side cache so a manual re-scan minutes
 *    after a cron scan re-reads the cache instead of Yahoo.
 *  - `quoteSummary(..., ['calendarEvents'])` *throws* for ETFs ("No fundamentals
 *    data found for symbol: XLE"). That is not an error — ETFs have no earnings —
 *    so it degrades to `null` events rather than failing the ticker.
 *  - Some symbols list no chain at all (`^TNX` returns zero expirations). Those
 *    are skipped loudly with a `no_chain` reason, never retried into oblivion.
 */

import { z } from "zod";

import { cached } from "../../cache";
import { features } from "../../env";
import { logger } from "../../logger";
import { yahooFinance } from "../../providers/yahoo";
import { err, ok, type AppError, type Result } from "../../types";
import { selectExpiries, toIsoDate } from "../expiry";
import { fixtureChainSnapshot } from "../fixtures";
import type {
  ChainSnapshot,
  HedgeContract,
  HedgeEvents,
  HedgeExpiry,
  OptionRight,
} from "../types";

import type { ChainProvider, ChainRequest } from "./types";

/* ── external payload validation ───────────────────────────────────────────── */

const DateLike = z.union([z.date(), z.number(), z.string()]);

const ContractSchema = z.object({
  contractSymbol: z.string().optional(),
  strike: z.number().finite(),
  bid: z.number().finite().optional(),
  ask: z.number().finite().optional(),
  lastPrice: z.number().finite().optional(),
  impliedVolatility: z.number().finite().optional(),
  volume: z.number().finite().optional(),
  openInterest: z.number().finite().optional(),
  lastTradeDate: DateLike.optional(),
  inTheMoney: z.boolean().optional(),
});

const ChainResultSchema = z.object({
  expirationDates: z.array(DateLike).optional(),
  quote: z
    .object({
      regularMarketPrice: z.number().finite().optional(),
      dividendYield: z.number().finite().optional(),
    })
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

const CalendarEventsSchema = z.object({
  calendarEvents: z
    .object({
      earnings: z
        .object({ earningsDate: z.array(DateLike).optional() })
        .optional(),
      exDividendDate: DateLike.optional(),
    })
    .optional(),
});

export const hedgeChainSchemas = {
  ContractSchema,
  ChainResultSchema,
  CalendarEventsSchema,
};

/* ── helpers ───────────────────────────────────────────────────────────────── */

/** Coerce Yahoo's Date | epoch-seconds | string into a `Date`, or `null`. */
function toDate(value: Date | number | string | undefined): Date | null {
  if (value === undefined) return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return new Date(value * 1000);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** `null` unless the number is finite and positive. */
const positive = (n: number | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;

/** `null` unless the number is finite and non-negative. */
const nonNegative = (n: number | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;

/** Map a validated Yahoo contract into the hedge domain shape. */
function mapContract(
  raw: z.infer<typeof ContractSchema>,
  right: OptionRight,
  expiration: string,
): HedgeContract {
  const lastTrade = toDate(raw.lastTradeDate);
  return {
    contractSymbol:
      raw.contractSymbol ?? `${expiration}:${right}:${raw.strike}`,
    right,
    strike: raw.strike,
    expiration,
    bid: nonNegative(raw.bid),
    ask: nonNegative(raw.ask),
    lastPrice: nonNegative(raw.lastPrice),
    impliedVolatility: positive(raw.impliedVolatility),
    volume: nonNegative(raw.volume),
    openInterest: nonNegative(raw.openInterest),
    lastTradeDate: lastTrade ? lastTrade.toISOString() : null,
    inTheMoney: raw.inTheMoney ?? false,
  };
}

/** Sleep for `ms`, used between retries and to stagger requests. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Does this error look like a rate limit or a transient upstream blip? */
function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|too many requests|timeout|socket|econnreset|etimedout/i.test(
    message,
  );
}

/** Options controlling how hard we lean on Yahoo. */
export interface YahooChainOptions {
  maxRetries: number;
  /** Random stagger applied before each request, as `[minMs, maxMs]`. */
  jitterMs: readonly [number, number];
  cacheTtlSeconds: number;
}

const DEFAULTS: YahooChainOptions = {
  maxRetries: 3,
  jitterMs: [120, 400],
  cacheTtlSeconds: 600,
};

/**
 * Run a Yahoo call with jitter, bounded retries and exponential backoff.
 *
 * Non-retryable errors (a symbol with no chain, a validation failure) fail on
 * the first attempt — retrying them just multiplies the load that got us rate
 * limited in the first place.
 */
async function withRetry<T>(
  label: string,
  opts: YahooChainOptions,
  fn: () => Promise<T>,
): Promise<Result<T, AppError>> {
  const [lo, hi] = opts.jitterMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    // Stagger every request, not just retries: a 60-ticker scan firing in
    // lockstep is exactly what trips Yahoo's limiter.
    await sleep(lo + Math.random() * Math.max(0, hi - lo));
    try {
      return ok(await fn());
    } catch (error) {
      const retryable = isRetryable(error);
      const last = attempt === opts.maxRetries;
      if (!retryable || last) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("hedge.yahoo request failed", {
          label,
          attempt,
          retryable,
          error: message,
        });
        return err({
          code: retryable ? "RATE_LIMITED" : "PROVIDER_ERROR",
          message,
        });
      }
      const backoff = 2 ** attempt * 500 + Math.random() * 250;
      logger.warn("hedge.yahoo retrying", { label, attempt, backoff });
      await sleep(backoff);
    }
  }
  return err({ code: "UNKNOWN", message: `${label}: retries exhausted` });
}

/**
 * Fetch earnings and ex-dividend dates.
 *
 * Never fails the ticker: Yahoo throws "No fundamentals data found" for ETFs and
 * indices, which is the correct answer (they have no earnings) rather than an
 * error, so it degrades to empty events.
 */
async function fetchEvents(ticker: string): Promise<HedgeEvents> {
  try {
    const raw: unknown = await yahooFinance.quoteSummary(
      ticker,
      { modules: ["calendarEvents"] },
      { validateResult: false },
    );
    const parsed = CalendarEventsSchema.safeParse(raw);
    if (!parsed.success) return { earningsDate: null, exDividendDate: null };

    const events = parsed.data.calendarEvents;
    const earnings = toDate(events?.earnings?.earningsDate?.[0]);
    const exDiv = toDate(events?.exDividendDate);
    return {
      earningsDate: earnings ? toIsoDate(earnings) : null,
      exDividendDate: exDiv ? toIsoDate(exDiv) : null,
    };
  } catch (error) {
    logger.debug("hedge.yahoo: no calendar events", {
      ticker,
      error: error instanceof Error ? error.message : String(error),
    });
    return { earningsDate: null, exDividendDate: null };
  }
}

/** Yahoo-backed implementation of {@link ChainProvider}. */
export class YahooChainProvider implements ChainProvider {
  readonly name = "yahoo";

  private readonly opts: YahooChainOptions;

  constructor(options: Partial<YahooChainOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * Capture a full multi-expiry chain for one underlying.
   *
   * @param request - Ticker and target tenors.
   * @returns The snapshot, or an {@link AppError}. Never throws.
   */
  async getChainSnapshot(
    request: ChainRequest,
  ): Promise<Result<ChainSnapshot, AppError>> {
    const { ticker, tenors, now } = request;

    if (features.forceFixtures) {
      return ok(fixtureChainSnapshot(ticker, now, tenors));
    }

    const key = `hedge:chain:${ticker}:${tenors.skew.join("-")}:${tenors.term.join("-")}:${toIsoDate(now)}`;
    const snapshot = await cached<ChainSnapshot | null>(
      key,
      this.opts.cacheTtlSeconds,
      () => this.fetchSnapshot(request),
    );

    if (!snapshot) {
      return err({
        code: "NOT_FOUND",
        message: `${ticker}: no option chain`,
      });
    }
    return ok(snapshot);
  }

  /** Fetch expirations, then one chain per selected tenor. */
  private async fetchSnapshot(
    request: ChainRequest,
  ): Promise<ChainSnapshot | null> {
    const { ticker, tenors, minDte, now } = request;

    // Call one: the expiration list and the underlying quote. Yahoo also
    // returns the front chain here, but the front expiration is a short-dated
    // weekly we almost never want, so it is discarded.
    const root = await withRetry(`options:${ticker}`, this.opts, () =>
      yahooFinance.options(ticker, {}, { validateResult: false }),
    );
    if (!root.ok) return null;

    const parsed = ChainResultSchema.safeParse(root.data);
    if (!parsed.success) {
      logger.warn("hedge.yahoo: chain failed schema validation", { ticker });
      return null;
    }

    const spot = positive(parsed.data.quote?.regularMarketPrice);
    const available = (parsed.data.expirationDates ?? [])
      .map(toDate)
      .filter((d): d is Date => d !== null);

    if (available.length === 0) {
      logger.warn("hedge.yahoo: symbol lists no expirations; skipping", {
        ticker,
      });
      return null;
    }

    const selected = selectExpiries(available, tenors, minDte, now);
    if (selected.length === 0) {
      logger.warn("hedge.yahoo: no expiration at or beyond minDte; skipping", {
        ticker,
        minDte,
        nearest: toIsoDate(available[0] ?? now),
      });
      return null;
    }

    // Fetch tenors sequentially: they belong to one ticker, and the scan already
    // runs several tickers concurrently. Parallelising here too would multiply
    // the burst width and is the fastest route to a 429.
    const expiries: HedgeExpiry[] = [];
    for (const sel of selected) {
      const result = await withRetry(
        `options:${ticker}@${sel.expiration}`,
        this.opts,
        () =>
          yahooFinance.options(
            ticker,
            { date: sel.date },
            { validateResult: false },
          ),
      );
      if (!result.ok) continue; // one bad tenor must not lose the other two

      const chain = ChainResultSchema.safeParse(result.data);
      const leg = chain.success ? chain.data.options?.[0] : undefined;
      if (!leg) continue;

      expiries.push({
        expiration: sel.expiration,
        dte: sel.dte,
        standardMonthly: sel.standardMonthly,
        targetDtes: sel.targetDtes,
        usableForSkew: sel.usableForSkew,
        calls: (leg.calls ?? []).map((c) =>
          mapContract(c, "call", sel.expiration),
        ),
        puts: (leg.puts ?? []).map((p) =>
          mapContract(p, "put", sel.expiration),
        ),
      });
    }

    if (expiries.length === 0) {
      logger.warn("hedge.yahoo: every tenor failed to fetch; skipping", {
        ticker,
      });
      return null;
    }

    const events = await fetchEvents(ticker);

    return {
      ticker: ticker.toUpperCase(),
      capturedAt: now.toISOString(),
      spot,
      availableExpirations: available.map(toIsoDate),
      expiries,
      events,
      source: this.name,
      fallback: false,
    };
  }
}
