import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse } from "@/lib/api";
import { getHedgeConfig } from "@/lib/hedge/config";
import { getDb } from "@/lib/hedge/db/client";
import { currentVersion, LATEST_VERSION } from "@/lib/hedge/db/migrations";
import { getHistoryDepth, getLatestScan } from "@/lib/hedge/db/repo";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * The response contract. Validated on the way out, like every other payload in
 * this app — a health endpoint that lies about the schema it reports is worse
 * than no health endpoint.
 */
const HealthSchema = z.object({
  schemaVersion: z.number().int(),
  expectedSchemaVersion: z.number().int(),
  universeSize: z.number().int(),
  lastScan: z
    .object({
      id: z.number().int(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      trigger: z.string(),
      status: z.string(),
      tickersOk: z.number().int(),
      tickersFailed: z.number().int(),
    })
    .nullable(),
  history: z.object({
    tickers: z.number().int(),
    days: z.number().int(),
    medianRealIvDays: z.number().int(),
    firstAsOf: z.string().nullable(),
    lastAsOf: z.string().nullable(),
  }),
  /**
   * The headline fact for a young install: until `medianRealIvDays` clears
   * `metrics.ivRankMinRealDays`, IV rank is a realized-volatility rank in
   * disguise and every value derived from it is flagged `proxied`.
   */
  ivRank: z.object({
    proxied: z.boolean(),
    realDays: z.number().int(),
    requiredDays: z.number().int(),
    lookbackDays: z.number().int(),
  }),
});

/** The health payload returned by `GET /api/hedge/health`. */
export type HedgeHealth = z.infer<typeof HealthSchema>;

/**
 * GET /api/hedge/health — schema version, scan history and IV-rank readiness.
 *
 * Doubles as the bootstrap step: opening the database applies any pending
 * migrations, so hitting this endpoint on a fresh deploy creates the schema.
 *
 * @returns The health payload as JSON, or a mapped error response.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const config = getHedgeConfig();
    // Opening the handle runs migrations — this is the bootstrap.
    const db = getDb();

    const depth = getHistoryDepth(db);
    const scan = getLatestScan(db);
    const required = config.metrics.ivRankMinRealDays;

    const payload: HedgeHealth = {
      schemaVersion: currentVersion(db),
      expectedSchemaVersion: LATEST_VERSION,
      universeSize: config.universe.length,
      lastScan: scan
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
      history: depth,
      ivRank: {
        proxied: depth.medianRealIvDays < required,
        realDays: depth.medianRealIvDays,
        requiredDays: required,
        lookbackDays: config.metrics.ivRankLookbackDays,
      },
    };

    return NextResponse.json(HealthSchema.parse(payload), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logger.error("api.hedge.health failed", { error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
