import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse } from "@/lib/api";
import { getHedgeConfig } from "@/lib/hedge/config";
import { getDb } from "@/lib/hedge/db/client";
import {
  getHistoryDepth,
  getLatestScan,
  getMetricsForScan,
  getPairMetrics,
  readMarketBrief,
} from "@/lib/hedge/db/repo";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const bool = (v: unknown): boolean => v === 1;
const str = (v: unknown): string | null => (v === null ? null : String(v));

/** One ticker on the heatmap. */
const TickerSchema = z.object({
  ticker: z.string(),
  spot: z.number().nullable(),
  ivRank: z.number().nullable(),
  ivPercentile: z.number().nullable(),
  ivRankProxied: z.boolean(),
  ivHistoryDays: z.number(),
  atmIv30: z.number().nullable(),
  atmIv90: z.number().nullable(),
  atm30Bracketed: z.boolean(),
  putSkew25d: z.number().nullable(),
  putSkewZ: z.number().nullable(),
  callPutSpread: z.number().nullable(),
  skew25dBracketed: z.boolean(),
  termSlope: z.number().nullable(),
  termInverted: z.boolean(),
  ewmaVol: z.number().nullable(),
  realizedVol20d: z.number().nullable(),
  vrp: z.number().nullable(),
  vrpZ: z.number().nullable(),
  pctVs200dma: z.number().nullable(),
  rsi14: z.number().nullable(),
  corrSpy60d: z.number().nullable(),
  earningsDate: z.string().nullable(),
  dataQuality: z.enum(["good", "degraded", "poor"]),
  contractsTotal: z.number().nullable(),
  parityViolations: z.number().nullable(),
  ratesFallback: z.boolean(),
  riskFreeRate: z.number().nullable(),
  dividendYield: z.number().nullable(),
});

const PairSchema = z.object({
  pairId: z.string(),
  ratio: z.number().nullable(),
  zScore: z.number().nullable(),
  halfLife: z.number().nullable(),
  ouLambda: z.number().nullable(),
  meanReversion: z.string(),
  tradeable: z.boolean(),
});

const OverviewSchema = z.object({
  scan: z
    .object({
      id: z.number(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      trigger: z.string(),
      status: z.string(),
      tickersOk: z.number(),
      tickersFailed: z.number(),
    })
    .nullable(),
  /** The proxy state, surfaced explicitly rather than buried in a code comment. */
  ivRank: z.object({
    proxied: z.boolean(),
    realDays: z.number(),
    requiredDays: z.number(),
    lookbackDays: z.number(),
  }),
  /** The whole-market AI read for this scan. Null before the first scan, or with AI off. */
  marketBrief: z
    .object({
      headline: z.string(),
      regime: z.string(),
      opportunities: z.string(),
      risks: z.string(),
      model: z.string(),
      fallback: z.boolean(),
    })
    .nullable(),
  tickers: z.array(TickerSchema),
  pairs: z.array(PairSchema),
  universeSize: z.number(),
});

/** The overview payload served to `/hedge`. */
export type HedgeOverview = z.infer<typeof OverviewSchema>;

/**
 * GET /api/hedge/overview — the market context, the heatmap and the pair monitor.
 *
 * @returns The latest completed scan's state, or an empty shell before the first scan.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const config = getHedgeConfig();
    const db = getDb();
    const scan = getLatestScan(db);
    const depth = getHistoryDepth(db);
    const required = config.metrics.ivRankMinRealDays;

    const rows = scan ? getMetricsForScan(scan.id, db) : [];
    const pairRows = scan ? getPairMetrics(scan.id, db) : [];

    // Read the brief this scan pointed at, not the most recently written one:
    // an unchanged market reuses an older cached row, so "newest" is the wrong
    // brief whenever the market returns to a state it has already been in.
    const brief = scan?.marketBriefHash
      ? readMarketBrief(scan.marketBriefHash, db)
      : null;

    const payload: HedgeOverview = {
      scan: scan
        ? {
            id: scan.id,
            startedAt: scan.startedAt,
            finishedAt: scan.finishedAt,
            trigger: scan.trigger,
            status: scan.status,
            tickersOk: scan.tickersOk,
            tickersFailed: scan.tickersFailed,
          }
        : null,
      ivRank: {
        proxied: depth.medianRealIvDays < required,
        realDays: depth.medianRealIvDays,
        requiredDays: required,
        lookbackDays: config.metrics.ivRankLookbackDays,
      },
      marketBrief: brief,
      tickers: rows.map((r) => ({
        ticker: String(r.ticker),
        spot: num(r.spot),
        ivRank: num(r.iv_rank),
        ivPercentile: num(r.iv_percentile),
        ivRankProxied: bool(r.iv_rank_proxied),
        ivHistoryDays: num(r.iv_history_days) ?? 0,
        atmIv30: num(r.atm_iv_30d),
        atmIv90: num(r.atm_iv_90d),
        atm30Bracketed: bool(r.atm_30d_bracketed),
        putSkew25d: num(r.put_skew_25d),
        putSkewZ: num(r.put_skew_z),
        callPutSpread: num(r.call_put_spread),
        skew25dBracketed: bool(r.skew_25d_bracketed),
        termSlope: num(r.term_slope),
        termInverted: bool(r.term_inverted),
        ewmaVol: num(r.ewma_vol),
        realizedVol20d: num(r.realized_vol_20d),
        vrp: num(r.vrp),
        vrpZ: num(r.vrp_z),
        pctVs200dma: num(r.pct_vs_200dma),
        rsi14: num(r.rsi14),
        corrSpy60d: num(r.corr_spy_60d),
        earningsDate: str(r.earnings_date),
        dataQuality: (str(r.data_quality) ?? "poor") as
          | "good"
          | "degraded"
          | "poor",
        contractsTotal: num(r.contracts_total),
        parityViolations: num(r.parity_violations),
        ratesFallback: bool(r.rates_fallback),
        riskFreeRate: num(r.risk_free_rate),
        dividendYield: num(r.dividend_yield),
      })),
      pairs: pairRows.map((r) => ({
        pairId: String(r.pair_id),
        ratio: num(r.ratio),
        zScore: num(r.zscore),
        halfLife: num(r.half_life),
        ouLambda: num(r.ou_lambda),
        meanReversion: str(r.mean_reversion) ?? "unknown",
        tradeable: str(r.mean_reversion) === "pass",
      })),
      universeSize: config.universe.length,
    };

    return NextResponse.json(OverviewSchema.parse(payload), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logger.error("api.hedge.overview failed", { error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
