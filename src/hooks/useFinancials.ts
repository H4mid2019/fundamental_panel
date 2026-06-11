"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiGet } from "@/lib/api-client";
import type { FinancialStatements, StatementFrequency } from "@/lib/types";

/**
 * Fetch the financial statements for a stock.
 *
 * @param symbol - The asset symbol, or `null` to disable the query.
 * @param frequency - Annual or quarterly periods.
 * @param enabled - Whether the asset has statements (stocks only).
 * @returns The TanStack Query result for the statements.
 */
export function useFinancials(
  symbol: string | null,
  frequency: StatementFrequency,
  enabled: boolean,
): UseQueryResult<FinancialStatements> {
  return useQuery({
    queryKey: ["financials", symbol, frequency],
    queryFn: () =>
      apiGet<FinancialStatements>(
        `/api/financials/${encodeURIComponent(symbol ?? "")}?freq=${frequency}`,
      ),
    enabled: Boolean(symbol) && enabled,
    staleTime: 60 * 60 * 1000,
  });
}
