import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { logger } from "@/lib/logger";
import { getFuturesQuotes } from "@/lib/providers/yahoo";

export const dynamic = "force-dynamic";

/**
 * GET /api/futures — quotes for the futures watchlist.
 *
 * @returns The futures quotes as JSON, or a mapped error response.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const result = await getFuturesQuotes();
    if (!result.ok) return errorResponse(result.error);
    return NextResponse.json(
      { quotes: result.data },
      { headers: { "Cache-Control": "public, s-maxage=60" } },
    );
  } catch (error) {
    logger.error("api.futures failed", { error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
