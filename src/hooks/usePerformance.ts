"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { PerformanceReturns } from "@/lib/types";

/**
 * Fetch trailing returns (YTD/1Y/3Y/5Y) for an asset.
 *
 * @param symbol - The asset symbol, or `null` to disable the query.
 * @returns The TanStack Query result for the performance returns.
 */
export function usePerformance(
  symbol: string | null,
): UseQueryResult<PerformanceReturns> {
  return useQuery({
    queryKey: ["performance", symbol],
    queryFn: () =>
      apiGet<PerformanceReturns>(
        `/api/performance/${encodeURIComponent(symbol ?? "")}`,
      ),
    enabled: Boolean(symbol),
    staleTime: 60 * 60 * 1000,
  });
}
