import { after, NextResponse } from "next/server";

import { errorResponse } from "@/lib/api";
import { env, features } from "@/lib/env";
import { runBackfill } from "@/lib/hedge/backfill";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/hedge/backfill — reconstruct the observation history.
 *
 * Rebuilds the realized-vol and EWMA series for every ticker from its candles
 * (which we already fetch), and overlays **real** implied vol from a CBOE index
 * for the handful of underlyings that have one. That is what makes the IV-rank-
 * gated scanners work before a year of scans has accumulated.
 *
 * Protected by the same secret as `/api/hedge/scan`, and disabled when it is
 * unset — a backfill is ~85 Yahoo fetches, and an open endpoint that triggers
 * them is a liability.
 *
 * Runs in `after()` and returns 202: a full backfill takes minutes.
 *
 * @param request - Carries the secret header.
 * @returns 202 once the backfill is scheduled.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!features.manualScan) {
    return errorResponse({
      code: "NOT_FOUND",
      message: "Backfill is disabled: HEDGE_SCAN_SECRET is not set",
    });
  }
  if (request.headers.get("x-hedge-secret") !== env.HEDGE_SCAN_SECRET) {
    return errorResponse({ code: "NOT_FOUND", message: "Not found" });
  }

  after(async () => {
    try {
      const result = await runBackfill();
      logger.info("hedge.backfill.complete", {
        tickers: result.tickers.length,
        totalDays: result.totalDays,
        withRealIv: result.withRealIv,
        withProxyOnly: result.withProxyOnly,
      });
    } catch (error) {
      logger.error("hedge.backfill failed", { error });
    }
  });

  return NextResponse.json(
    {
      status: "scheduled",
      message:
        "Backfill started. Realized-vol history is rebuilt for every ticker; " +
        "real implied-vol history is overlaid for the five with a CBOE index " +
        "(SPY, QQQ, DIA, GLD, USO). Poll /api/hedge/health.",
    },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}
