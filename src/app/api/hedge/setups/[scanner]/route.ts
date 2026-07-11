import { NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse } from "@/lib/api";
import { getDb } from "@/lib/hedge/db/client";
import { getLatestScan, getSetups } from "@/lib/hedge/db/repo";
import { SCANNER_IDS, type ScannerId } from "@/lib/hedge/scanners";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const ScannerParam = z.enum(SCANNER_IDS);

const LegSchema = z.object({
  action: z.enum(["buy", "sell"]),
  right: z.enum(["call", "put"]),
  strike: z.number(),
  expiration: z.string(),
  dte: z.number(),
  mid: z.number(),
  iv: z.number(),
  absDelta: z.number(),
  openInterest: z.number().nullable(),
  relSpread: z.number(),
});

const SetupSchema = z.object({
  scanner: z.string(),
  ticker: z.string(),
  score: z.number(),
  legs: z.array(LegSchema),
  stats: z.record(z.string(), z.number().nullable()),
  summary: z.string(),
  warnings: z.array(z.string()),
  proxied: z.boolean(),
  ratesFallback: z.boolean(),
  dataQuality: z.enum(["good", "degraded", "poor"]),
  signalHash: z.string(),
  /** The AI note, when one has been generated for this signal. */
  interpretation: z
    .object({
      meaning: z.string(),
      risk: z.string(),
      invalidation: z.string(),
      model: z.string(),
      fallback: z.boolean(),
    })
    .nullable(),
});

const ResponseSchema = z.object({
  scanner: z.string(),
  scanId: z.number().nullable(),
  setups: z.array(SetupSchema),
});

/**
 * GET /api/hedge/setups/[scanner] — the ranked board for one scanner.
 *
 * The AI note (if any) is joined in from `ai_cache` by signal hash, so a re-render
 * never re-bills the model.
 *
 * @param _request - Unused.
 * @param ctx - Route context carrying the async `scanner` param.
 * @returns The ranked setups as JSON.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ scanner: string }> },
): Promise<NextResponse> {
  const { scanner } = await ctx.params;
  const parsed = ScannerParam.safeParse(scanner);
  if (!parsed.success) {
    return errorResponse({
      code: "VALIDATION_ERROR",
      message: `Unknown scanner: ${scanner}`,
    });
  }

  try {
    const db = getDb();
    const scan = getLatestScan(db);
    if (!scan) {
      return NextResponse.json(
        ResponseSchema.parse({
          scanner: parsed.data,
          scanId: null,
          setups: [],
        }),
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const setups = getSetups(scan.id, parsed.data satisfies ScannerId, db);

    const hydrated = setups.map((s) => {
      const cached = db.get<{
        payload: string;
        model: string;
        fallback: number;
      }>(
        `SELECT payload, model, fallback FROM ai_cache
          WHERE ticker = :ticker AND signal_hash = :hash`,
        { ticker: s.ticker, hash: s.signalHash },
      );

      let interpretation = null;
      if (cached) {
        try {
          const body = JSON.parse(cached.payload) as {
            meaning: string;
            risk: string;
            invalidation: string;
          };
          interpretation = {
            meaning: body.meaning,
            risk: body.risk,
            invalidation: body.invalidation,
            model: cached.model,
            fallback: cached.fallback === 1,
          };
        } catch {
          interpretation = null;
        }
      }

      return { ...s, interpretation };
    });

    return NextResponse.json(
      ResponseSchema.parse({
        scanner: parsed.data,
        scanId: scan.id,
        setups: hydrated,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    logger.error("api.hedge.setups failed", { scanner, error });
    return errorResponse({ code: "UNKNOWN", message: "Internal error" });
  }
}
