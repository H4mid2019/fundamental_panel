"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { HedgeOverview } from "@/app/api/hedge/overview/route";
import { apiGet } from "@/lib/api-client";
import type { ScannerId } from "@/lib/hedge/scanners/types";

/** One leg of a setup, as served by the API. */
export interface HedgeLeg {
  action: "buy" | "sell";
  right: "call" | "put";
  strike: number;
  expiration: string;
  dte: number;
  mid: number;
  iv: number;
  absDelta: number;
  openInterest: number | null;
  relSpread: number;
}

/** A setup with its (optional) AI note attached. */
export interface HedgeSetup {
  scanner: string;
  ticker: string;
  score: number;
  legs: HedgeLeg[];
  stats: Record<string, number | null>;
  summary: string;
  warnings: string[];
  proxied: boolean;
  ratesFallback: boolean;
  dataQuality: "good" | "degraded" | "poor";
  signalHash: string;
  interpretation: {
    meaning: string;
    risk: string;
    invalidation: string;
    model: string;
    fallback: boolean;
  } | null;
}

interface SetupsResponse {
  scanner: string;
  scanId: number | null;
  setups: HedgeSetup[];
}

/** An alert in the feed. */
export interface HedgeAlert {
  id: number;
  createdAt: string;
  ticker: string;
  type: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  proxied: boolean;
  deliveredSlack: boolean;
}

/** Market context, heatmap and pair monitor. */
export function useHedgeOverview() {
  return useQuery({
    queryKey: ["hedge", "overview"],
    queryFn: () => apiGet<HedgeOverview>("/api/hedge/overview"),
    // A scan runs twice a day; polling harder than this just burns battery.
    refetchInterval: 60_000,
  });
}

/** The ranked board for one scanner. */
export function useHedgeSetups(scanner: ScannerId) {
  return useQuery({
    queryKey: ["hedge", "setups", scanner],
    queryFn: () => apiGet<SetupsResponse>(`/api/hedge/setups/${scanner}`),
  });
}

/** The alert feed. */
export function useHedgeAlerts() {
  return useQuery({
    queryKey: ["hedge", "alerts"],
    queryFn: () =>
      apiGet<{ alerts: HedgeAlert[] }>("/api/hedge/alerts?limit=50"),
    refetchInterval: 60_000,
  });
}

/**
 * Trigger a scan by hand.
 *
 * The endpoint returns 202 immediately and runs the scan in the background, so
 * this resolves long before the scan finishes — the overview poll is what
 * eventually shows the result.
 */
export function useRunScan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (secret: string) => {
      const response = await fetch("/api/hedge/scan", {
        method: "POST",
        headers: { "x-hedge-secret": secret },
      });
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "Manual scan is disabled or the secret is wrong."
            : `Scan failed to start (${response.status}).`,
        );
      }
      return (await response.json()) as { status: string; message: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["hedge"] });
    },
  });
}
