import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { logger } from "@/lib/logger";
import { getMacroMetrics } from "@/lib/providers/fred";

export const revalidate = 3600;

/**
 * GET /api/macro — macro indicators for the sidebar (refreshed hourly).
 *
 * @returns The macro metrics as JSON, or a mapped error response.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const result = await getMacroMetrics();
    if (!result.ok) return errorResponse(result.error);
    return NextResponse.json(
      { metrics: result.data },
      { headers: { "Cache-Control": "public, s-maxage=3600" } },
    );
  } catch (error) {
    logger.error("api.macro failed", { error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
