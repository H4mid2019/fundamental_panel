"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiPost } from "@/lib/api-client";
import type {
  AIBrief,
  AssetSnapshot,
  IndicatorSet,
  NewsAnalysis,
} from "@/lib/types";

/** Extra context fed to the AI brief alongside the fundamentals. */
export interface AIBriefContext {
  news?: NewsAnalysis;
  macro?: {
    label: string;
    value: number | null;
    unit: string;
    reading: string;
  }[];
  performance?: {
    ytd: number | null;
    oneY: number | null;
    threeY: number | null;
    fiveY: number | null;
  };
  options?: { putCallRatio: number | null; atmIV: number | null };
}

/**
 * Fetch the AI brief for an asset, feeding fundamentals + news + macro +
 * trailing returns + options positioning.
 *
 * Enabled only once `ready` is true (all context queries have settled), so the
 * model is called at most once per asset with full context. Keyed by all inputs
 * so it refetches when any of them change.
 *
 * @param snapshot - The asset snapshot (for name/type), or `undefined`.
 * @param indicatorSet - The computed indicator set, or `undefined`.
 * @param ready - Whether all context inputs have settled.
 * @param context - News, macro, performance and options context.
 * @returns The TanStack Query result for the AI brief.
 */
export function useAIBrief(
  snapshot: AssetSnapshot | undefined,
  indicatorSet: IndicatorSet | undefined,
  ready: boolean,
  context: AIBriefContext,
): UseQueryResult<AIBrief> {
  const valuesKey = indicatorSet?.indicators
    .map((i) => `${i.id}:${i.value ?? "n"}`)
    .join(",");
  const contextKey = JSON.stringify([
    context.news?.index ?? null,
    context.macro?.map((m) => [m.label, m.value]) ?? null,
    context.performance ?? null,
    context.options ?? null,
  ]);

  return useQuery({
    queryKey: ["ai-brief", indicatorSet?.symbol, valuesKey, contextKey],
    enabled: Boolean(snapshot && indicatorSet && ready),
    staleTime: 6 * 60 * 60 * 1000,
    queryFn: () => {
      if (!snapshot || !indicatorSet) {
        throw new Error("AI brief requires snapshot and indicators");
      }
      return apiPost<AIBrief>("/api/ai-brief", {
        symbol: indicatorSet.symbol,
        name: snapshot.name,
        assetType: indicatorSet.assetType,
        indicators: indicatorSet.indicators.map((i) => ({
          id: i.id,
          label: i.label,
          value: i.value,
          unit: i.unit,
          sentiment: i.sentiment,
        })),
        ...(context.news
          ? {
              newsIndex: context.news.index,
              newsHeadlines: context.news.topTitles,
            }
          : {}),
        ...(context.macro && context.macro.length > 0
          ? { macro: context.macro }
          : {}),
        ...(context.performance ? { performance: context.performance } : {}),
        ...(context.options ? { options: context.options } : {}),
      });
    },
  });
}
