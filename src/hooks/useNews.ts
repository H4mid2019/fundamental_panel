"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { NewsAnalysis } from "@/lib/types";

/**
 * Fetch the weighted news analysis for an asset.
 *
 * @param symbol - The asset symbol, or `null` to disable the query.
 * @returns The TanStack Query result for the news analysis.
 */
export function useNews(symbol: string | null): UseQueryResult<NewsAnalysis> {
  return useQuery({
    queryKey: ["news", symbol],
    queryFn: () =>
      apiGet<NewsAnalysis>(`/api/news/${encodeURIComponent(symbol ?? "")}`),
    enabled: Boolean(symbol),
    staleTime: 15 * 60 * 1000,
  });
}
