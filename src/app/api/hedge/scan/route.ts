import { after, NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { env, features } from "@/lib/env";
import { runScan } from "@/lib/hedge/scan";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
/** A full scan of 85 tickers takes minutes; do not let the platform cut it short. */
export const maxDuration = 300;

/**
 * POST /api/hedge/scan — trigger a scan by hand.
 *
 * Protected by a shared secret in the `x-hedge-secret` header. When
 * `HEDGE_SCAN_SECRET` is unset the endpoint is **disabled** rather than left open:
 * an unauthenticated endpoint that hammers Yahoo with 500 requests is a liability,
 * and failing closed is the only safe default.
 *
 * Returns immediately and runs the scan in `after()`, because a scan takes minutes
 * and the browser should not be holding a socket open for it. Poll
 * `/api/hedge/overview` for the result.
 *
 * @param request - Carries the secret header.
 * @returns 202 once the scan is scheduled.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!features.manualScan) {
    return errorResponse({
      code: "NOT_FOUND",
      message: "Manual scan is disabled: HEDGE_SCAN_SECRET is not set",
    });
  }

  const provided = request.headers.get("x-hedge-secret");
  if (provided !== env.HEDGE_SCAN_SECRET) {
    return errorResponse({ code: "NOT_FOUND", message: "Not found" });
  }

  // Kick the scan off after the response is flushed.
  after(async () => {
    try {
      const result = await runScan({ trigger: "manual" });
      logger.info("hedge.scan.manual complete", {
        scanId: result.scanId,
        status: result.status,
      });
    } catch (error) {
      logger.error("hedge.scan.manual failed", { error });
    }
  });

  return NextResponse.json(
    { status: "scheduled", message: "Scan started; poll /api/hedge/overview" },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
