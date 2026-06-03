import { NextResponse } from "next/server";

import { errorResponse, SymbolSchema } from "@/lib/api";
import { logger } from "@/lib/logger";
import { getOptionsChain } from "@/lib/providers/options";

export const dynamic = "force-dynamic";

/**
 * GET /api/options/[symbol]?expiration=YYYY-MM-DD — options chain for a stock
 * or index.
 *
 * @param request - The incoming request (carries the optional `expiration`).
 * @param ctx - Route context carrying the async `symbol` param.
 * @returns The options chain as JSON, or a mapped error response.
 */
export async function GET(
  request: Request,
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

  const expirationRaw = new URL(request.url).searchParams.get("expiration");
  const expiration =
    expirationRaw && /^\d{4}-\d{2}-\d{2}$/.test(expirationRaw)
      ? expirationRaw
      : undefined;

  try {
    const result = await getOptionsChain(parsed.data, expiration);
    if (!result.ok) return errorResponse(result.error);
    return NextResponse.json(result.data, {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    logger.error("api.options failed", { symbol: parsed.data, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
