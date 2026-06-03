"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { AssetSnapshot } from "@/lib/types";

/**
 * Fetch the headline snapshot for an asset.
 *
 * @param symbol - The asset symbol, or `null` to disable the query.
 * @returns The TanStack Query result for the snapshot.
 */
export function useAsset(symbol: string | null): UseQueryResult<AssetSnapshot> {
  return useQuery({
    queryKey: ["asset", symbol],
    queryFn: () =>
      apiGet<AssetSnapshot>(`/api/asset/${encodeURIComponent(symbol ?? "")}`),
    enabled: Boolean(symbol),
  });
}
