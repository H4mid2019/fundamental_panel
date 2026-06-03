"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { IndicatorSet } from "@/lib/types";

/**
 * Fetch the indicator set for an asset.
 *
 * @param symbol - The asset symbol, or `null` to disable the query.
 * @returns The TanStack Query result for the indicator set.
 */
export function useIndicators(
  symbol: string | null,
): UseQueryResult<IndicatorSet> {
  return useQuery({
    queryKey: ["indicators", symbol],
    queryFn: () =>
      apiGet<IndicatorSet>(
        `/api/indicators/${encodeURIComponent(symbol ?? "")}`,
      ),
    enabled: Boolean(symbol),
  });
}
