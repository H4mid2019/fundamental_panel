"use client";

import { Plus, Wifi, X } from "lucide-react";
import dynamic from "next/dynamic";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSeriesCandles } from "@/hooks/useCandles";
import {
  INDICATORS,
  SERIES_COLORS,
  type ChartSeriesSpec,
  type IndicatorId,
  type ResolvedSeries,
} from "@/lib/chart/series";
import {
  CHART_ASSETS,
  DEFAULT_CHART_ASSET,
  findChartAsset,
  type ChartAsset,
} from "@/lib/chart/symbols";
import { CHART_INTERVALS, type ChartInterval } from "@/lib/chart/types";
import { cn } from "@/lib/utils";

const TradingChart = dynamic(
  () => import("./TradingChart").then((m) => m.TradingChart),
  { ssr: false },
);

const MAX_SERIES = 4;

/** Asset kinds in display order, for grouped <optgroup>s. */
const KIND_LABELS: Record<ChartAsset["kind"], string> = {
  crypto: "Crypto",
  index: "Indexes",
  future: "Futures & Commodities",
  fx: "FX",
  stock: "Stocks",
};

/** Format a price compactly for the legend. */
function fmt(v: number | null): string {
  if (v === null) return "—";
  const abs = Math.abs(v);
  const dp = abs >= 1000 ? 0 : abs >= 1 ? 2 : 5;
  return v.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

/** Grouped <option>s for the asset selects. */
function AssetOptions(): React.JSX.Element {
  const kinds = Object.keys(KIND_LABELS) as ChartAsset["kind"][];
  return (
    <>
      {kinds.map((kind) => {
        const group = CHART_ASSETS.filter((a) => a.kind === kind);
        if (group.length === 0) return null;
        return (
          <optgroup key={kind} label={KIND_LABELS[kind]}>
            {group.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

const selectCls =
  "h-8 rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Hidden data component: resolves one series and lifts the result up. */
function SeriesLoader({
  spec,
  interval,
  onResolved,
}: {
  spec: ChartSeriesSpec;
  interval: ChartInterval;
  onResolved: (r: ResolvedSeries) => void;
}): null {
  const r = useSeriesCandles(spec, interval);
  const {
    id,
    label,
    color,
    isRatio,
    visible,
    candles,
    isLoading,
    isError,
    fallback,
    lastValue,
  } = r;
  React.useEffect(() => {
    onResolved({
      id,
      label,
      color,
      isRatio,
      visible,
      candles,
      isLoading,
      isError,
      fallback,
      lastValue,
    });
  }, [
    id,
    label,
    color,
    isRatio,
    visible,
    candles,
    isLoading,
    isError,
    fallback,
    lastValue,
    onResolved,
  ]);
  return null;
}

/** The interactive chart workspace: controls, data loaders, chart and legend. */
export function ChartWorkspace(): React.JSX.Element {
  const idCounter = React.useRef(1);
  const [interval, setInterval] = React.useState<ChartInterval>("1h");
  const [specs, setSpecs] = React.useState<ChartSeriesSpec[]>(() => [
    {
      id: "s0",
      numerator: DEFAULT_CHART_ASSET,
      denominator: null,
      color: SERIES_COLORS[0],
      visible: true,
    },
  ]);
  const [resolvedMap, setResolvedMap] = React.useState<
    Record<string, ResolvedSeries>
  >({});
  const [indicators, setIndicators] = React.useState<Set<IndicatorId>>(
    () => new Set(),
  );
  const [normalize, setNormalize] = React.useState(false);

  const onResolved = React.useCallback((r: ResolvedSeries) => {
    setResolvedMap((prev) => ({ ...prev, [r.id]: r }));
  }, []);

  const seriesList = React.useMemo(
    () =>
      specs
        .map((s) => resolvedMap[s.id])
        .filter((r): r is ResolvedSeries => Boolean(r)),
    [specs, resolvedMap],
  );

  // Order-flow studies need a single Binance crypto primary leg.
  const primarySpec = specs[0];
  const orderFlowAvailable =
    primarySpec?.numerator.source === "binance" &&
    primarySpec.denominator === null;

  const addSeries = (): void => {
    if (specs.length >= MAX_SERIES) return;
    const idx = specs.length;
    idCounter.current += 1;
    setSpecs((prev) => [
      ...prev,
      {
        id: `s${idCounter.current}`,
        numerator: findChartAsset("ETH") ?? DEFAULT_CHART_ASSET,
        denominator: null,
        color: SERIES_COLORS[idx % SERIES_COLORS.length] ?? SERIES_COLORS[0],
        visible: true,
      },
    ]);
    if (specs.length === 1) setNormalize(true); // auto-compare on 2nd series
  };

  const removeSeries = (id: string): void =>
    setSpecs((prev) =>
      prev.length > 1 ? prev.filter((s) => s.id !== id) : prev,
    );

  const updateSpec = (id: string, patch: Partial<ChartSeriesSpec>): void =>
    setSpecs((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const toggleIndicator = (id: IndicatorId): void =>
    setIndicators((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      {/* Data loaders (render nothing). */}
      {specs.map((spec) => (
        <SeriesLoader
          key={spec.id}
          spec={spec}
          interval={interval}
          onResolved={onResolved}
        />
      ))}

      {/* Interval + view controls */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border p-1">
          {CHART_INTERVALS.map((iv) => (
            <Button
              key={iv}
              size="sm"
              variant={iv === interval ? "default" : "ghost"}
              onClick={() => setInterval(iv)}
            >
              {iv}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant={normalize ? "default" : "outline"}
          onClick={() => setNormalize((n) => !n)}
          title="Rebase all series to % change for comparison"
        >
          % Compare
        </Button>
      </div>

      {/* Series manager */}
      <div className="flex flex-col gap-2 rounded-lg border p-3">
        {specs.map((spec, idx) => (
          <div key={spec.id} className="flex flex-wrap items-center gap-2">
            <span
              className="inline-block size-3 rounded-full"
              style={{ backgroundColor: spec.color }}
              aria-hidden
            />
            <span className="w-12 text-xs text-muted-foreground">
              {idx === 0 ? "Primary" : `Series ${idx + 1}`}
            </span>
            <select
              className={selectCls}
              value={spec.numerator.id}
              onChange={(e) => {
                const next = findChartAsset(e.target.value);
                if (next) updateSpec(spec.id, { numerator: next });
              }}
              aria-label="Numerator asset"
            >
              <AssetOptions />
            </select>
            <span className="text-muted-foreground">/</span>
            <select
              className={selectCls}
              value={spec.denominator?.id ?? ""}
              onChange={(e) =>
                updateSpec(spec.id, {
                  denominator: e.target.value
                    ? (findChartAsset(e.target.value) ?? null)
                    : null,
                })
              }
              aria-label="Denominator asset"
            >
              <option value="">— none (vs USD) —</option>
              <AssetOptions />
            </select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => updateSpec(spec.id, { visible: !spec.visible })}
            >
              {spec.visible ? "Hide" : "Show"}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              disabled={specs.length === 1}
              onClick={() => removeSeries(spec.id)}
              aria-label="Remove series"
            >
              <X />
            </Button>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={addSeries}
            disabled={specs.length >= MAX_SERIES}
          >
            <Plus /> Add asset {specs.length}/{MAX_SERIES}
          </Button>
        </div>
      </div>

      {/* Indicator picker */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border p-3">
        {INDICATORS.map((ind) => {
          const disabled = Boolean(ind.needsOrderFlow) && !orderFlowAvailable;
          const active = indicators.has(ind.id);
          return (
            <Button
              key={ind.id}
              size="sm"
              variant={active ? "default" : "outline"}
              disabled={disabled}
              onClick={() => toggleIndicator(ind.id)}
              title={
                disabled
                  ? "Order-flow studies need a single Binance crypto series"
                  : undefined
              }
            >
              {ind.label}
            </Button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {seriesList.map((s) => (
          <span key={s.id} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ backgroundColor: s.color }}
              aria-hidden
            />
            <span className={cn(!s.visible && "line-through opacity-50")}>
              {s.label}
            </span>
            <span className="font-mono text-muted-foreground">
              {fmt(s.lastValue)}
            </span>
            {s.fallback ? (
              <Badge variant="unknown" className="text-[10px]">
                demo
              </Badge>
            ) : !s.isRatio ? (
              <Wifi className="size-3 text-bullish" aria-label="live" />
            ) : null}
          </span>
        ))}
      </div>

      {/* Chart */}
      <div className="h-[60vh] min-h-[420px] w-full rounded-lg border p-1">
        <TradingChart
          series={seriesList}
          indicators={indicators}
          normalize={normalize}
        />
      </div>
    </div>
  );
}
