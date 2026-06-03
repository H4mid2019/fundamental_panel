import YahooFinance from "yahoo-finance2";
import { z } from "zod";

import { resolveAssetType } from "../assets";
import { features } from "../env";
import { getPerformanceFixture } from "../fixtures";
import { logger } from "../logger";
import {
  ok,
  type AppError,
  type PerformanceReturns,
  type Result,
} from "../types";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const DAY = 86_400_000;

const ChartSchema = z.object({
  meta: z
    .object({ regularMarketPrice: z.number().finite().optional() })
    .optional(),
  quotes: z.array(
    z.object({
      date: z.union([z.date(), z.number(), z.string()]),
      close: z.number().finite().nullable().optional(),
    }),
  ),
});

export const performanceSchemas = { ChartSchema };

interface Point {
  ms: number;
  close: number;
}

function toMs(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  return Date.parse(value);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Compute trailing returns from a monthly close series.
 *
 * @param points - Ascending `{ ms, close }` points.
 * @param current - The latest price.
 * @param nowMs - Current time in ms since epoch.
 * @returns YTD/1Y/3Y/5Y percentage returns (null when unavailable).
 */
export function computeReturns(
  points: Point[],
  current: number,
  nowMs: number,
): Pick<PerformanceReturns, "ytd" | "oneY" | "threeY" | "fiveY"> {
  const closeAtOrBefore = (targetMs: number): number | null => {
    let base: number | null = null;
    for (const p of points) {
      if (p.ms <= targetMs) base = p.close;
      else break;
    }
    return base;
  };
  const pct = (base: number | null): number | null =>
    base && base > 0 ? round1((current / base - 1) * 100) : null;

  const yearStart = Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1);
  return {
    ytd: pct(closeAtOrBefore(yearStart)),
    oneY: pct(closeAtOrBefore(nowMs - 365 * DAY)),
    threeY: pct(closeAtOrBefore(nowMs - 3 * 365 * DAY)),
    fiveY: pct(closeAtOrBefore(nowMs - 5 * 365 * DAY)),
  };
}

/**
 * Fetch trailing returns for an asset via Yahoo, with fixture fallback.
 *
 * @param symbol - The asset symbol.
 * @returns A {@link Result} that resolves to the performance returns.
 */
export async function getPerformance(
  symbol: string,
): Promise<Result<PerformanceReturns, AppError>> {
  const now = Date.now();
  if (features.forceFixtures) {
    return ok({
      ...getPerformanceFixture(symbol),
      asOf: new Date(now).toISOString(),
    });
  }
  const type = resolveAssetType(symbol);
  const yahooSymbol =
    type === "crypto" ? `${symbol.toUpperCase()}-USD` : symbol;

  try {
    const raw: unknown = await yahooFinance.chart(yahooSymbol, {
      period1: new Date(now - (5 * 365 + 60) * DAY),
      interval: "1mo",
    });
    const parsed = ChartSchema.safeParse(raw);
    if (!parsed.success) {
      return ok({
        ...getPerformanceFixture(symbol),
        asOf: new Date(now).toISOString(),
      });
    }

    const points: Point[] = parsed.data.quotes
      .map((q) => ({ ms: toMs(q.date), close: q.close ?? Number.NaN }))
      .filter((p) => Number.isFinite(p.ms) && Number.isFinite(p.close))
      .sort((a, b) => a.ms - b.ms);

    const current =
      parsed.data.meta?.regularMarketPrice ?? points[points.length - 1]?.close;
    if (current === undefined || points.length === 0) {
      return ok({
        ...getPerformanceFixture(symbol),
        asOf: new Date(now).toISOString(),
      });
    }

    return ok({
      symbol: symbol.toUpperCase(),
      ...computeReturns(points, current, now),
      asOf: new Date(now).toISOString(),
      fallback: false,
    });
  } catch (error) {
    logger.warn("yahoo.chart failed; using fixture performance", {
      symbol,
      error,
    });
    return ok({
      ...getPerformanceFixture(symbol),
      asOf: new Date(now).toISOString(),
    });
  }
}
