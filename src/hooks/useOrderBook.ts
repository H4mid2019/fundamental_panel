"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { OrderBook } from "@/lib/types";

/**
 * Fetch the L2 order book for a crypto asset (polled for liveness).
 *
 * @param symbol - The asset symbol, or `null` to disable the query.
 * @param enabled - Whether the asset is crypto (gates the query).
 * @returns The TanStack Query result for the order book.
 */
export function useOrderBook(
  symbol: string | null,
  enabled: boolean,
): UseQueryResult<OrderBook> {
  return useQuery({
    queryKey: ["orderbook", symbol],
    queryFn: () =>
      apiGet<OrderBook>(`/api/orderbook/${encodeURIComponent(symbol ?? "")}`),
    enabled: Boolean(symbol) && enabled,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}
