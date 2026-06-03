"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { AssetRef } from "@/lib/types";

interface SearchResponse {
  results: AssetRef[];
}

/**
 * Search assets by ticker or company name.
 *
 * @param query - The (already debounced) search text.
 * @returns The TanStack Query result for matching assets.
 */
export function useSearch(query: string): UseQueryResult<SearchResponse> {
  return useQuery({
    queryKey: ["search", query],
    queryFn: () =>
      apiGet<SearchResponse>(`/api/search?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 1,
    staleTime: 5 * 60 * 1000,
  });
}
