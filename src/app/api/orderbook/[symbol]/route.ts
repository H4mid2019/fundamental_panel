import { NextResponse } from "next/server";

import { errorResponse, SymbolSchema } from "@/lib/api";
import { resolveAssetType } from "@/lib/assets";
import { logger } from "@/lib/logger";
import { getOrderBook } from "@/lib/providers/binance";

export const dynamic = "force-dynamic";

/**
 * GET /api/orderbook/[symbol] — L2 order book for a crypto asset.
 *
 * @param _request - The incoming request (unused).
 * @param ctx - Route context carrying the async `symbol` param.
 * @returns The order book as JSON, or a mapped error response.
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
  if (resolveAssetType(parsed.data) !== "crypto") {
    return errorResponse({
      code: "NOT_FOUND",
      message: "Order books are only available for crypto assets",
    });
  }

  try {
    const result = await getOrderBook(parsed.data);
    if (!result.ok) return errorResponse(result.error);
    return NextResponse.json(result.data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logger.error("api.orderbook failed", { symbol: parsed.data, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
