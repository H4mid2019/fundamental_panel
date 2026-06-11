"use client";

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { apiGet } from "@/lib/api-client";
import { computeRatioCandles, ratioLabel } from "@/lib/chart/pairs";
import type { ChartSeriesSpec, ResolvedSeries } from "@/lib/chart/series";
import type { ChartAsset } from "@/lib/chart/symbols";
import { INTERVAL_SECONDS } from "@/lib/chart/symbols";
import type {
  Candle,
  CandleSeriesPayload,
  ChartInterval,
} from "@/lib/chart/types";

import { useBinanceLiveCandle } from "./useBinanceLiveCandle";

const LIMIT = 500;

/** Poll cadence (ms) used as a liveness backstop for non-WS sources. */
function refetchMs(interval: ChartInterval): number {
  return Math.min(60_000, Math.max(10_000, INTERVAL_SECONDS[interval] * 250));
}

/** Fetch raw candles for one leg via `/api/candles`. */
function useLegCandles(
  asset: ChartAsset | null,
  interval: ChartInterval,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["candles", asset?.source, asset?.providerSymbol, interval],
    queryFn: () => {
      if (!asset) throw new Error("No asset");
      const params = new URLSearchParams({
        source: asset.source,
        symbol: asset.providerSymbol,
        interval,
        limit: String(LIMIT),
      });
      return apiGet<CandleSeriesPayload>(`/api/candles?${params.toString()}`);
    },
    enabled: enabled && asset !== null,
    staleTime: refetchMs(interval) / 2,
    refetchInterval: refetchMs(interval),
  });
}

/** Merge a live bar into a candle array (replace last or append). */
function mergeLive(candles: Candle[], live: Candle | null): Candle[] {
  const last = candles[candles.length - 1];
  if (!live || !last) return candles;
  if (live.time < last.time) return candles;
  if (live.time === last.time) return [...candles.slice(0, -1), live];
  return [...candles, live];
}

/**
 * Resolve a {@link ChartSeriesSpec} to candles: fetches the numerator and (for
 * ratio pairs) denominator legs, derives the ratio, and folds in live Binance
 * updates for single crypto legs.
 *
 * @param spec - The series specification.
 * @param interval - The shared chart timeframe.
 * @returns The {@link ResolvedSeries}.
 */
export function useSeriesCandles(
  spec: ChartSeriesSpec,
  interval: ChartInterval,
): ResolvedSeries {
  const num = useLegCandles(spec.numerator, interval, true);
  const den = useLegCandles(
    spec.denominator,
    interval,
    spec.denominator !== null,
  );

  const isRatio = spec.denominator !== null;
  // Live WS only for a single Binance crypto leg.
  const liveEnabled = !isRatio && spec.numerator.source === "binance";
  const live = useBinanceLiveCandle(
    liveEnabled ? spec.numerator.providerSymbol : null,
    interval,
    liveEnabled,
  );

  const label = spec.denominator
    ? ratioLabel(spec.numerator.id, spec.denominator.id)
    : spec.numerator.label;

  const candles = React.useMemo<Candle[]>(() => {
    const numCandles = num.data?.candles ?? [];
    if (!isRatio) return mergeLive(numCandles, live);
    const denCandles = den.data?.candles ?? [];
    return computeRatioCandles(numCandles, denCandles);
  }, [num.data, den.data, isRatio, live]);

  const isLoading = num.isLoading || (isRatio && den.isLoading);
  const isError = num.isError || (isRatio && den.isError);
  const fallback =
    Boolean(num.data?.fallback) || Boolean(isRatio && den.data?.fallback);

  return {
    id: spec.id,
    label,
    color: spec.color,
    isRatio,
    visible: spec.visible,
    candles,
    isLoading,
    isError,
    fallback,
    lastValue: candles[candles.length - 1]?.close ?? null,
  };
}
