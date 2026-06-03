import { NextResponse } from "next/server";

import { errorResponse, SymbolSchema } from "@/lib/api";
import { logger } from "@/lib/logger";
import { getIndicatorSet } from "@/lib/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/indicators/[symbol] — the full indicator set for an asset.
 *
 * @param _request - The incoming request (unused).
 * @param ctx - Route context carrying the async `symbol` param.
 * @returns The indicator set as JSON, or a mapped error response.
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
    const result = await getIndicatorSet(parsed.data);
    if (!result.ok) return errorResponse(result.error);
    return NextResponse.json(result.data, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    logger.error("api.indicators failed", { symbol: parsed.data, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
