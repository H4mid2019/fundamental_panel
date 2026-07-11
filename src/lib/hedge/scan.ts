/**
 * The full scan: fetch → metrics → scanners → alerts → AI → persist.
 *
 * The governing rule, as everywhere in HedgeScope, is that **one bad ticker never
 * costs the scan**. Yahoo has no chain for some symbols, throws for others, and
 * rate-limits under load; a universe of 85 will always have casualties. Each is
 * captured independently, failures are recorded with a reason, and the scan
 * finishes `partial` rather than `failed`.
 */

import type { Candle } from "../chart/types";
import { logger } from "../logger";

import { interpretSetups, type Interpretation } from "./ai/interpret";
import { buildAlerts, fireAlerts, type AlertRecord } from "./alerts/engine";
import { deliverToSlack } from "./alerts/slack";
import { getHedgeConfig, type HedgeConfig } from "./config";
import type { HedgeDb } from "./db/client";
import {
  countRealIvDays,
  finishScan,
  getHistory,
  insertChainSnapshot,
  insertMetrics,
  insertPairMetrics,
  insertSetups,
  startScan,
  upsertHistory,
  type ScanTrigger,
} from "./db/repo";
import { toIsoDate } from "./expiry";
import {
  computeMetrics,
  fillCrossSectionalSkewZ,
  toHistoryRow,
  type TickerMetrics,
} from "./metrics/engine";
import { computePair, type PairMetric } from "./metrics/pairs";
import {
  buildSurface,
  type RateContext,
  type Surface,
} from "./metrics/surface";
import { mapWithConcurrency } from "./pool";
import { getRiskFreeRate } from "./providers/rates";
import type { ChainProvider } from "./providers/types";
import { getUnderlying, type UnderlyingData } from "./providers/underlying";
import { YahooChainProvider } from "./providers/yahoo";
import {
  buildTailHedgeSetup,
  computeTailHedgeSignal,
  rankSetups,
  runScanners,
  type RankedSetups,
  type Setup,
  type TailHedgeSignal,
} from "./scanners";
import type { SkippedTicker } from "./types";

/** What a completed scan produced. */
export interface ScanResult {
  scanId: number;
  status: "ok" | "partial" | "failed";
  metrics: TickerMetrics[];
  pairs: PairMetric[];
  setups: RankedSetups;
  alerts: AlertRecord[];
  interpretations: Map<string, Interpretation>;
  tailHedge: TailHedgeSignal | null;
  skipped: SkippedTicker[];
}

/** Injectable collaborators, so a scan is testable with no network. */
export interface ScanOptions {
  trigger: ScanTrigger;
  tickers?: readonly string[];
  provider?: ChainProvider;
  db?: HedgeDb;
  now?: Date;
  /** Skip the AI step (used by tests and by the backfill). */
  skipAi?: boolean;
}

/** One ticker's fetched inputs. */
interface TickerData {
  ticker: string;
  surface: Surface;
  metrics: TickerMetrics;
  underlying: UnderlyingData;
}

/**
 * Trailing return of HYG minus LQD, in percent — the credit-divergence term of
 * the tail-hedge composite. Credit stress shows up here before it shows up in
 * equity vol, which is the entire premise of the monitor.
 */
function creditDivergence(
  candles: Map<string, Candle[]>,
  lookback = 20,
): number | null {
  const ret = (ticker: string): number | null => {
    const c = candles.get(ticker);
    if (!c || c.length < lookback + 1) return null;
    const last = c[c.length - 1]?.close;
    const prior = c[c.length - 1 - lookback]?.close;
    if (!last || !prior || prior <= 0) return null;
    return (last / prior - 1) * 100;
  };
  const hyg = ret("HYG");
  const lqd = ret("LQD");
  return hyg !== null && lqd !== null ? hyg - lqd : null;
}

/**
 * Run a complete scan.
 *
 * @param options - Trigger and any injected collaborators.
 * @returns Everything the scan produced.
 */
export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const config: HedgeConfig = getHedgeConfig();
  const now = options.now ?? new Date();
  const asOf = toIsoDate(now);
  const db = options.db;
  const tickers = options.tickers ?? config.universe;

  const provider =
    options.provider ??
    new YahooChainProvider({
      maxRetries: config.chain.maxRetries,
      jitterMs: [config.chain.jitterMs[0], config.chain.jitterMs[1]],
      cacheTtlSeconds: config.chain.cacheTtlSeconds,
    });

  const scanId = startScan(options.trigger, db);
  logger.info("hedge.scan.start", {
    scanId,
    trigger: options.trigger,
    tickers: tickers.length,
  });

  const skipped: SkippedTicker[] = [];

  try {
    // ── The rate environment, once for the whole scan. ──
    const rf = await getRiskFreeRate(now);

    // ── The benchmark, needed by every ticker's correlation. ──
    const benchmark = config.context.benchmark;
    const benchU = await getUnderlying(benchmark, now);
    const benchCandles = benchU.ok ? benchU.data.candles : [];
    if (benchCandles.length === 0) {
      logger.warn(
        "hedge.scan: no benchmark candles; correlations will be null",
        {
          benchmark,
        },
      );
    }

    // Every ticker whose candles we need: the universe, plus the pair legs.
    const pairLegs = new Set(
      config.pairs.list.flatMap((p) => [p.numerator, p.denominator]),
    );
    const candleTickers = [...new Set([...tickers, ...pairLegs])];
    const candles = new Map<string, Candle[]>();

    // ── Fetch chains + underlyings, bounded. ──
    const fetched = await mapWithConcurrency(
      candleTickers,
      config.chain.concurrency,
      async (ticker): Promise<TickerData | SkippedTicker | null> => {
        const u = await getUnderlying(ticker, now);
        if (u.ok) candles.set(ticker, u.data.candles);

        // A pair leg that is not in the universe needs candles only.
        if (!tickers.includes(ticker)) return null;

        if (!u.ok) {
          return {
            ticker,
            reason: "provider_error",
            detail: u.error.message,
          } satisfies SkippedTicker;
        }

        const chain = await provider.getChainSnapshot({
          ticker,
          tenors: config.chain.tenors,
          minDte: config.chain.minDte,
          now,
        });
        if (!chain.ok) {
          return {
            ticker,
            reason:
              chain.error.code === "NOT_FOUND" ? "no_chain" : "provider_error",
            detail: chain.error.message,
          } satisfies SkippedTicker;
        }
        if (chain.data.spot === null) {
          return {
            ticker,
            reason: "no_spot",
            detail: "provider returned no underlying price",
          } satisfies SkippedTicker;
        }

        // A1: the delta every downstream number depends on is computed with the
        // real rate and this ticker's real dividend yield. When either is
        // missing, the row is flagged rather than quietly presented as exact.
        const q = u.data.dividends.q;
        const rates: RateContext = {
          r: rf.rate,
          q: q ?? 0,
          fallback: rf.fallback || q === null,
        };

        const surface = buildSurface(chain.data, rates, config);
        if (!surface) {
          return {
            ticker,
            reason: "no_spot",
            detail: "could not build a volatility surface",
          } satisfies SkippedTicker;
        }

        const metrics = computeMetrics(
          {
            snapshot: chain.data,
            candles: u.data.candles,
            benchmarkCandles: benchCandles,
            rates,
            history: getHistory(ticker, config.metrics.ivRankLookbackDays, db),
            realIvDays: countRealIvDays(ticker, db),
          },
          config,
        );
        if (!metrics) {
          return {
            ticker,
            reason: "no_spot",
            detail: "metrics could not be computed",
          } satisfies SkippedTicker;
        }

        insertChainSnapshot(scanId, chain.data, db);
        return { ticker, surface, metrics, underlying: u.data };
      },
    );

    const data: TickerData[] = [];
    for (const entry of fetched) {
      if (entry === null) continue;
      if ("reason" in entry) {
        skipped.push(entry);
        continue;
      }
      data.push(entry);
    }

    for (const s of skipped) {
      logger.warn("hedge.scan.skipped", {
        scanId,
        ticker: s.ticker,
        reason: s.reason,
        detail: s.detail,
      });
    }

    // Skew has no free historical source, so a fresh install has no time-series
    // z-score to rank `putDebitSpread` on. Fall back to a cross-section of the
    // universe today — a different, weaker question, and flagged as such.
    const metrics = fillCrossSectionalSkewZ(data.map((d) => d.metrics));

    // ── Persist metrics + the observation series ranks are built on. ──
    insertMetrics(scanId, metrics, asOf, db);
    upsertHistory(
      metrics.map((m) => toHistoryRow(m, asOf)),
      db,
    );

    // ── Pairs (A3: the mean-reversion guard is applied inside). ──
    const pairs: PairMetric[] = config.pairs.list
      .map((p) => {
        const num = candles.get(p.numerator);
        const den = candles.get(p.denominator);
        if (!num || !den) {
          logger.warn("hedge.scan: pair leg missing candles; skipping", {
            pair: p.id,
          });
          return null;
        }
        return computePair(
          p,
          num,
          den,
          config.pairs.lookbackDays,
          config.pairs.minHalfLife,
          config.pairs.maxHalfLife,
        );
      })
      .filter((p): p is PairMetric => p !== null);
    insertPairMetrics(scanId, pairs, db);

    // ── Per-ticker scanners. ──
    const setups: Setup[] = [];
    for (const d of data) {
      setups.push(
        ...runScanners({
          metrics: d.metrics,
          surface: d.surface,
          dividends: d.underlying.dividends,
          config,
        }),
      );
    }

    // ── Tail hedge: one market-regime read, not a per-ticker screen. ──
    const spy = data.find((d) => d.ticker === benchmark);
    const vixTerm = await fetchVixTerm(config, now);
    const tailHedge = computeTailHedgeSignal(
      {
        vixTerm,
        creditDivergencePct: creditDivergence(candles),
        spyPutSkew: spy?.metrics.putSkew25d ?? null,
        spyIvRank: spy?.metrics.ivRank ?? null,
      },
      config.scanners.tailHedge.minCompositeScore,
    );

    for (const underlying of config.context.tailHedgeUnderlyings) {
      const d = data.find((x) => x.ticker === underlying);
      if (!d) continue;
      const setup = buildTailHedgeSetup(
        {
          metrics: d.metrics,
          surface: d.surface,
          dividends: d.underlying.dividends,
          config,
        },
        tailHedge,
      );
      if (setup) setups.push(setup);
    }

    const ranked = rankSetups(setups, config);
    insertSetups(scanId, ranked, db);

    // ── Alerts (deduped by cooldown inside `fireAlerts`). ──
    const drafts = buildAlerts(metrics, pairs, setups, config);
    const alerts = fireAlerts(drafts, scanId, config, db, now);
    await deliverToSlack(alerts, db);

    // ── AI interpretation of the top N setups. ──
    const top = Object.values(ranked)
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, config.ai.topN);

    const interpretations =
      options.skipAi || !config.ai.enabled
        ? new Map<string, Interpretation>()
        : await interpretSetups(top, db);

    const status =
      data.length === 0 ? "failed" : skipped.length > 0 ? "partial" : "ok";

    finishScan(
      scanId,
      {
        status,
        tickersOk: data.length,
        tickersFailed: skipped.length,
        ...(data.length === 0
          ? { error: "no ticker produced a usable chain" }
          : {}),
      },
      db,
    );

    logger.info("hedge.scan.done", {
      scanId,
      status,
      ok: data.length,
      skipped: skipped.length,
      setups: setups.length,
      alerts: alerts.length,
      tailHedgeFiring: tailHedge.firing,
    });

    return {
      scanId,
      status,
      metrics,
      pairs,
      setups: ranked,
      alerts,
      interpretations,
      tailHedge,
      skipped,
    };
  } catch (error) {
    // Anything escaping here is a bug, not a bad ticker. Close the scan row so it
    // never sits `running` forever.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("hedge.scan.failed", { scanId, error: message });
    finishScan(
      scanId,
      {
        status: "failed",
        tickersOk: 0,
        tickersFailed: skipped.length,
        error: message,
      },
      db,
    );
    throw error;
  }
}

/** VIX term-structure levels, from the configured index symbols. */
async function fetchVixTerm(
  config: HedgeConfig,
  now: Date,
): Promise<{ symbol: string; value: number }[]> {
  const out: { symbol: string; value: number }[] = [];
  for (const symbol of config.context.vixTerm) {
    const u = await getUnderlying(symbol, now);
    if (!u.ok || u.data.spot === null) continue;
    out.push({ symbol, value: u.data.spot });
  }
  return out;
}
