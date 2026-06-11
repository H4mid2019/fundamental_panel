import { NextResponse } from "next/server";

import { errorResponse, SymbolSchema } from "@/lib/api";
import { logger } from "@/lib/logger";
import { getFinancials } from "@/lib/service";
import type { StatementFrequency } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/financials/[symbol]?freq=annual|quarterly — financial statements
 * (income statement, balance sheet, cash flow) for a stock.
 *
 * @param request - The incoming request (carries the optional `freq`).
 * @param ctx - Route context carrying the async `symbol` param.
 * @returns The statements as JSON, or a mapped error response.
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

  const freqRaw = new URL(request.url).searchParams.get("freq");
  const frequency: StatementFrequency =
    freqRaw === "quarterly" ? "quarterly" : "annual";

  try {
    const result = await getFinancials(parsed.data, frequency);
    if (!result.ok) return errorResponse(result.error);
    return NextResponse.json(result.data, {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    logger.error("api.financials failed", { symbol: parsed.data, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
