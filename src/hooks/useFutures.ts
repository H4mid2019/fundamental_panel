"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { FuturesQuote } from "@/lib/types";

interface FuturesResponse {
  quotes: FuturesQuote[];
}

/**
 * Fetch the futures watchlist quotes.
 *
 * @returns The TanStack Query result for the futures quotes.
 */
export function useFutures(): UseQueryResult<FuturesResponse> {
  return useQuery({
    queryKey: ["futures"],
    queryFn: () => apiGet<FuturesResponse>("/api/futures"),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
