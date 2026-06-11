"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { PeerBenchmarks } from "@/lib/types";

/**
 * Fetch the peer-benchmark comparison for a stock.
 *
 * @param symbol - The asset symbol, or `null` to disable the query.
 * @param enabled - Whether the asset supports peers (stocks only).
 * @returns The TanStack Query result for the peer benchmarks.
 */
export function usePeers(
  symbol: string | null,
  enabled: boolean,
): UseQueryResult<PeerBenchmarks> {
  return useQuery({
    queryKey: ["peers", symbol],
    queryFn: () =>
      apiGet<PeerBenchmarks>(`/api/peers/${encodeURIComponent(symbol ?? "")}`),
    enabled: Boolean(symbol) && enabled,
    staleTime: 15 * 60 * 1000,
  });
}
