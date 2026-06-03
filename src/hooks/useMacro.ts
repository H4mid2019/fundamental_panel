"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { MacroMetric } from "@/lib/types";

interface MacroResponse {
  metrics: MacroMetric[];
}

/**
 * Fetch the macro sidebar metrics (refreshed hourly).
 *
 * @returns The TanStack Query result for the macro metrics.
 */
export function useMacro(): UseQueryResult<MacroResponse> {
  return useQuery({
    queryKey: ["macro"],
    queryFn: () => apiGet<MacroResponse>("/api/macro"),
    staleTime: 60 * 60 * 1000,
  });
}
