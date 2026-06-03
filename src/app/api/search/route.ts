import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { logger } from "@/lib/logger";
import { getSymbolSearch } from "@/lib/providers/yahoo";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=... — search assets by ticker or company name.
 *
 * @param request - The incoming request (carries the `q` query param).
 * @returns Matching assets as JSON, or a mapped error response.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const query = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 64);
  try {
    const results = await getSymbolSearch(query);
    return NextResponse.json(
      { results },
      { headers: { "Cache-Control": "public, s-maxage=300" } },
    );
  } catch (error) {
    logger.error("api.search failed", { query, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
