import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse } from "@/lib/api";
import { listAlerts } from "@/lib/hedge/alerts/engine";
import { getDb } from "@/lib/hedge/db/client";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const AlertSchema = z.object({
  id: z.number(),
  createdAt: z.string(),
  ticker: z.string(),
  type: z.string(),
  severity: z.enum(["info", "warn", "critical"]),
  title: z.string(),
  detail: z.string(),
  proxied: z.boolean(),
  deliveredSlack: z.boolean(),
});

const ResponseSchema = z.object({ alerts: z.array(AlertSchema) });

/**
 * GET /api/hedge/alerts — the alert feed, newest first.
 *
 * @returns Recent alerts as JSON.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const limitRaw = new URL(request.url).searchParams.get("limit");
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(limitRaw ?? "50", 10) || 50),
    );

    const alerts = listAlerts(limit, getDb()).map((a) => ({
      id: a.id,
      createdAt: a.createdAt,
      ticker: a.ticker,
      type: a.type,
      severity: a.severity,
      title: a.title,
      detail: a.detail,
      proxied: a.proxied,
      deliveredSlack: a.deliveredSlack,
    }));

    return NextResponse.json(ResponseSchema.parse({ alerts }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logger.error("api.hedge.alerts failed", { error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
