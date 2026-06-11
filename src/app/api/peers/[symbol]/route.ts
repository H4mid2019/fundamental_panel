import { NextResponse } from "next/server";

import { errorResponse, SymbolSchema } from "@/lib/api";
import { logger } from "@/lib/logger";
import { getPeerBenchmarks } from "@/lib/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/peers/[symbol] — peer-benchmark comparison for a stock.
 *
 * @param _request - The incoming request (unused).
 * @param ctx - Route context carrying the async `symbol` param.
 * @returns The peer benchmarks as JSON, or a mapped error response.
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

  try {
    const result = await getPeerBenchmarks(parsed.data);
    if (!result.ok) return errorResponse(result.error);
    return NextResponse.json(result.data, {
      headers: {
        "Cache-Control": "public, s-maxage=900, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    logger.error("api.peers failed", { symbol: parsed.data, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
