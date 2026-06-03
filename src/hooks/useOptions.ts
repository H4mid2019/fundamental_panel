"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { OptionsChain } from "@/lib/types";

/**
 * Fetch the options chain for a stock or index.
 *
 * @param symbol - The asset symbol, or `null` to disable the query.
 * @param enabled - Whether the asset supports options (stocks/indexes).
 * @param expiration - Optional selected expiration (ISO date).
 * @returns The TanStack Query result for the options chain.
 */
export function useOptions(
  symbol: string | null,
  enabled: boolean,
  expiration?: string,
): UseQueryResult<OptionsChain> {
  return useQuery({
    queryKey: ["options", symbol, expiration ?? "default"],
    queryFn: () => {
      const q = expiration ? `?expiration=${expiration}` : "";
      return apiGet<OptionsChain>(
        `/api/options/${encodeURIComponent(symbol ?? "")}${q}`,
      );
    },
    enabled: Boolean(symbol) && enabled,
    staleTime: 5 * 60 * 1000,
  });
}
