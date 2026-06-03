"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiPost } from "@/lib/api-client";
import type {
  AIBrief,
  AssetSnapshot,
  IndicatorSet,
  NewsAnalysis,
} from "@/lib/types";

/**
 * Fetch the AI brief for an asset's indicator set and news.
 *
 * Enabled once the snapshot and indicators are loaded and news has settled
 * (success or error), so the model is called at most once per asset. Keyed by
 * indicator values and the news index so it refetches when inputs change.
 *
 * @param snapshot - The asset snapshot (for name/type), or `undefined`.
 * @param indicatorSet - The computed indicator set, or `undefined`.
 * @param news - The news analysis, or `undefined`.
 * @param newsSettled - Whether the news query has finished (success or error).
 * @returns The TanStack Query result for the AI brief.
 */
export function useAIBrief(
  snapshot: AssetSnapshot | undefined,
  indicatorSet: IndicatorSet | undefined,
  news: NewsAnalysis | undefined,
  newsSettled: boolean,
): UseQueryResult<AIBrief> {
  const valuesKey = indicatorSet?.indicators
    .map((i) => `${i.id}:${i.value ?? "n"}`)
    .join(",");

  return useQuery({
    queryKey: ["ai-brief", indicatorSet?.symbol, valuesKey, news?.index],
    enabled: Boolean(snapshot && indicatorSet && newsSettled),
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
        ...(news
          ? { newsIndex: news.index, newsHeadlines: news.topTitles }
          : {}),
      });
    },
  });
}
