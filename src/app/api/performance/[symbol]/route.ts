import { NextResponse } from "next/server";

import { errorResponse, SymbolSchema } from "@/lib/api";
import { getCached, setCached } from "@/lib/cache";
import { logger } from "@/lib/logger";
import { getPerformance } from "@/lib/providers/performance";
import type { PerformanceReturns } from "@/lib/types";

export const dynamic = "force-dynamic";

const TTL_SECONDS = 60 * 60;

/**
 * GET /api/performance/[symbol] — trailing returns (YTD/1Y/3Y/5Y).
 *
 * @param _request - The incoming request (unused).
 * @param ctx - Route context carrying the async `symbol` param.
 * @returns The performance returns as JSON, or a mapped error response.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ symbol: string }> },
): Promise<NextResponse> {
  const { symbol } = await ctx.params;
  const parsed = SymbolSchema.safeParse(symbol);
  if (!parsed.success) {
    return errorResponse({
      code: "VALIDATION_ERROR",
      message: "Invalid symbol",
    });
  }

  const cacheKey = `perf:${parsed.data.toUpperCase()}`;
  try {
    const cachedValue = await getCached<PerformanceReturns>(cacheKey);
    if (cachedValue) return NextResponse.json(cachedValue);

    const result = await getPerformance(parsed.data);
    if (!result.ok) return errorResponse(result.error);
    await setCached(cacheKey, result.data, TTL_SECONDS);
    return NextResponse.json(result.data, {
      headers: { "Cache-Control": "public, s-maxage=3600" },
    });
  } catch (error) {
    logger.error("api.performance failed", { symbol: parsed.data, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
