import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse } from "@/lib/api";
import { cached } from "@/lib/cache";
import { INTERVAL_SECONDS } from "@/lib/chart/symbols";
import { CHART_INTERVALS } from "@/lib/chart/types";
import { logger } from "@/lib/logger";
import { DEFAULT_LIMIT, getCandles, MAX_LIMIT } from "@/lib/providers/candles";

export const dynamic = "force-dynamic";

/** Query schema. Provider symbols allow `=`/`^`/`.`/`-` (e.g. `GC=F`, `^GSPC`). */
const QuerySchema = z.object({
  source: z.enum(["binance", "hyperliquid", "yahoo"]),
  symbol: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[\^A-Za-z0-9.=\-]+$/, "Invalid symbol"),
  interval: z.enum(CHART_INTERVALS),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

/** Cache TTL (seconds): about half a bar, bounded to [15s, 30m]. */
function ttlFor(interval: (typeof CHART_INTERVALS)[number]): number {
  return Math.min(
    1800,
    Math.max(15, Math.floor(INTERVAL_SECONDS[interval] / 2)),
  );
}

/**
 * GET /api/candles — OHLCV bars for one leg of the chart.
 *
 * Query: `source` (binance|hyperliquid|yahoo), `symbol` (provider-native),
 * `interval` (1m…1wk), optional `limit`.
 *
 * @param request - The incoming request.
 * @returns A {@link CandleSeriesPayload} as JSON, or a mapped error.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    source: url.searchParams.get("source"),
    symbol: url.searchParams.get("symbol"),
    interval: url.searchParams.get("interval"),
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return errorResponse({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0]?.message ?? "Invalid query",
    });
  }

  const { source, symbol, interval, limit } = parsed.data;
  const ttl = ttlFor(interval);
  try {
    const payload = await cached(
      `candles:${source}:${symbol}:${interval}:${limit}`,
      ttl,
      () => getCandles(source, symbol, interval, limit),
    );
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": `public, s-maxage=${ttl}, stale-while-revalidate=${ttl}`,
      },
    });
  } catch (error) {
    logger.error("api.candles failed", { source, symbol, interval, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
