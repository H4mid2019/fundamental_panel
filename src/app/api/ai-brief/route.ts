import { NextResponse } from "next/server";
import { z } from "zod";

import { getAIBrief } from "@/lib/ai/openrouter";
import { clientIp, errorResponse, SymbolSchema } from "@/lib/api";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

const BriefRequestSchema = z.object({
  symbol: SymbolSchema,
  name: z.string().min(1).max(120),
  assetType: z.enum(["stock", "index", "crypto"]),
  indicators: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        label: z.string().min(1).max(60),
        value: z.number().finite().nullable(),
        unit: z.string().max(8),
        sentiment: z.enum(["bullish", "neutral", "bearish", "unknown"]),
      }),
    )
    .min(1)
    .max(40),
  newsIndex: z.number().min(-100).max(100).optional(),
  newsHeadlines: z.array(z.string().min(1).max(300)).max(20).optional(),
  macro: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        value: z.number().finite().nullable(),
        unit: z.string().max(8),
        reading: z.string().max(16),
      }),
    )
    .max(10)
    .optional(),
  performance: z
    .object({
      ytd: z.number().finite().nullable(),
      oneY: z.number().finite().nullable(),
      threeY: z.number().finite().nullable(),
      fiveY: z.number().finite().nullable(),
    })
    .optional(),
  options: z
    .object({
      putCallRatio: z.number().finite().nullable(),
      atmIV: z.number().finite().nullable(),
    })
    .optional(),
});

/**
 * POST /api/ai-brief — generate (or fetch cached) an AI brief for an asset.
 *
 * Rate limited to 10 requests/minute per client IP.
 *
 * @param request - The incoming request carrying the JSON brief input.
 * @returns The AI brief as JSON, or a mapped error response.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ip = clientIp(request);
  const limit = rateLimit(`ai-brief:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.allowed) {
    return errorResponse(
      {
        code: "RATE_LIMITED",
        message: "Too many requests. Try again shortly.",
      },
      { "Retry-After": String(Math.ceil((limit.resetAt - Date.now()) / 1000)) },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse({
      code: "VALIDATION_ERROR",
      message: "Invalid JSON body",
    });
  }

  const parsed = BriefRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse({
      code: "VALIDATION_ERROR",
      message: "Request failed validation",
    });
  }

  try {
    const result = await getAIBrief(parsed.data);
    if (!result.ok) return errorResponse(result.error);
    return NextResponse.json(result.data, {
      headers: { "X-RateLimit-Remaining": String(limit.remaining) },
    });
  } catch (error) {
    logger.error("api.ai-brief failed", { symbol: parsed.data.symbol, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
