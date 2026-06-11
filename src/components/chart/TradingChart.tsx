"use client";

import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useTheme } from "next-themes";
import * as React from "react";

import {
  bollinger,
  cvd,
  detectDivergences,
  ema,
  hasOrderFlow,
  macd,
  ofi,
  rsi,
  sma,
  vpin,
  vwap,
  type HistPoint,
  type LinePoint,
} from "@/lib/chart/indicators";
import type { IndicatorId, PaneId, ResolvedSeries } from "@/lib/chart/series";
import type { Candle } from "@/lib/chart/types";

interface TradingChartProps {
  series: ResolvedSeries[];
  indicators: Set<IndicatorId>;
  /** Compare mode: rebase every series to % change from the first bar. */
  normalize: boolean;
}

const ut = (t: number): UTCTimestamp => t as UTCTimestamp;
const toLine = (pts: LinePoint[]) =>
  pts.map((p) => ({ time: ut(p.time), value: p.value }));
const toHist = (pts: HistPoint[]) =>
  pts.map((p) => ({ time: ut(p.time), value: p.value, color: p.color }));

/** Order in which oscillator panes are stacked below the price pane. */
const PANE_ORDER: PaneId[] = ["rsi", "macd", "cvd", "ofi", "vpin"];

/** Rebase a candle series to percent change from its first close. */
function normalizeLine(candles: Candle[]): LinePoint[] {
  const first = candles[0];
  if (!first || first.close === 0) return [];
  const base = first.close;
  return candles.map((c) => ({
    time: c.time,
    value: (c.close / base - 1) * 100,
  }));
}

/**
 * TradingView-style multi-series chart built on `lightweight-charts` v5.
 *
 * The chart instance is created once; a structural effect (re)builds series and
 * panes when the layout changes, and a lighter data effect streams fresh candle
 * data into existing series so live updates stay smooth.
 */
export function TradingChart({
  series,
  indicators,
  normalize,
}: TradingChartProps): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  // Logical-id → series API (e.g. `price:<id>`, `sma20`, `macd.line`).
  const seriesRef = React.useRef<Map<string, ISeriesApi<SeriesType>>>(
    new Map(),
  );
  const markersRef = React.useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";

  // Create the chart once on mount.
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const seriesMap = seriesRef.current;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        attributionLogo: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesMap.clear();
      markersRef.current = null;
    };
  }, []);

  // Apply theme colors live (no chart recreation, so series persist).
  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      layout: { textColor: dark ? "#d1d5db" : "#374151" },
      grid: {
        vertLines: { color: dark ? "#1f2937" : "#e5e7eb" },
        horzLines: { color: dark ? "#1f2937" : "#e5e7eb" },
      },
      rightPriceScale: { borderColor: dark ? "#374151" : "#d1d5db" },
      timeScale: { borderColor: dark ? "#374151" : "#d1d5db" },
    });
  }, [dark]);

  // Structural signature: which series/indicators/modes are present.
  const structureKey = React.useMemo(
    () =>
      JSON.stringify({
        s: series.map((x) => [x.id, x.color, x.visible]),
        i: [...indicators].sort(),
        n: normalize,
      }),
    [series, indicators, normalize],
  );

  const primary = series[0];
  const orderFlow = primary ? hasOrderFlow(primary.candles) : false;

  // (Re)build series and panes when the structure changes.
  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of seriesRef.current.values()) chart.removeSeries(s);
    seriesRef.current.clear();
    markersRef.current = null;
    if (series.length === 0) return;

    const single = series.length === 1 && !normalize;

    // Price pane (0): candlesticks for a single absolute series, else lines.
    series.forEach((s, idx) => {
      if (!s.visible) return;
      if (idx === 0 && single) {
        const candle = chart.addSeries(CandlestickSeries, {
          upColor: "#26a69a",
          downColor: "#ef5350",
          borderUpColor: "#26a69a",
          borderDownColor: "#ef5350",
          wickUpColor: "#26a69a",
          wickDownColor: "#ef5350",
        });
        seriesRef.current.set(`price:${s.id}`, candle);
      } else {
        // Each absolute overlay gets its own hidden scale so shapes are
        // comparable; normalized lines share the right scale.
        const priceScaleId = normalize ? "right" : `sc-${s.id}`;
        const line = chart.addSeries(LineSeries, {
          color: s.color,
          lineWidth: 2,
          priceScaleId,
          lastValueVisible: true,
          priceLineVisible: false,
        });
        if (!normalize) {
          chart
            .priceScale(priceScaleId)
            .applyOptions({ scaleMargins: { top: 0.1, bottom: 0.2 } });
        }
        seriesRef.current.set(`price:${s.id}`, line);
      }
    });

    // Price-pane overlays only make sense in single absolute mode.
    if (single) {
      const overlay = (id: string, color: string, width: 1 | 2 = 2): void => {
        seriesRef.current.set(
          id,
          chart.addSeries(LineSeries, {
            color,
            lineWidth: width,
            priceLineVisible: false,
            lastValueVisible: false,
          }),
        );
      };
      if (indicators.has("sma20")) overlay("sma20", "#26c6da");
      if (indicators.has("sma50")) overlay("sma50", "#ffa726");
      if (indicators.has("ema20")) overlay("ema20", "#7e57c2");
      if (indicators.has("ema50")) overlay("ema50", "#ec407a");
      if (indicators.has("vwap")) overlay("vwap", "#fbc02d");
      if (indicators.has("bb")) {
        overlay("bb.upper", "#90a4ae", 1);
        overlay("bb.basis", "#607d8b", 1);
        overlay("bb.lower", "#90a4ae", 1);
      }
    }

    // Markers (divergence) on the primary price series.
    const primarySeries = primary
      ? seriesRef.current.get(`price:${primary.id}`)
      : undefined;
    if (
      primarySeries &&
      (indicators.has("divRsi") || indicators.has("divCvd"))
    ) {
      markersRef.current = createSeriesMarkers(primarySeries, []);
    }

    // Oscillator/flow panes below the price pane.
    let paneIndex = 1;
    for (const pane of PANE_ORDER) {
      if (!indicators.has(pane)) continue;
      if ((pane === "cvd" || pane === "ofi" || pane === "vpin") && !orderFlow) {
        continue;
      }
      if (pane === "macd") {
        seriesRef.current.set(
          "macd.hist",
          chart.addSeries(
            HistogramSeries,
            { priceLineVisible: false },
            paneIndex,
          ),
        );
        seriesRef.current.set(
          "macd.line",
          chart.addSeries(
            LineSeries,
            {
              color: "#2962ff",
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
            },
            paneIndex,
          ),
        );
        seriesRef.current.set(
          "macd.signal",
          chart.addSeries(
            LineSeries,
            {
              color: "#ff6d00",
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
            },
            paneIndex,
          ),
        );
      } else if (pane === "ofi") {
        seriesRef.current.set(
          "ofi",
          chart.addSeries(
            HistogramSeries,
            { priceLineVisible: false },
            paneIndex,
          ),
        );
      } else {
        seriesRef.current.set(
          pane,
          chart.addSeries(
            LineSeries,
            {
              color: pane === "rsi" ? "#ab47bc" : "#26a69a",
              lineWidth: 2,
              priceLineVisible: false,
              lastValueVisible: false,
            },
            paneIndex,
          ),
        );
      }
      paneIndex += 1;
    }

    // Give the price pane more room than the oscillator panes.
    const panes = chart.panes();
    if (panes.length > 1) {
      panes[0]?.setStretchFactor(3);
      for (let i = 1; i < panes.length; i += 1) panes[i]?.setStretchFactor(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // Stream candle/indicator data into the existing series.
  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart || series.length === 0) return;
    const map = seriesRef.current;
    const single = series.length === 1 && !normalize;

    // Price data.
    for (const s of series) {
      const api = map.get(`price:${s.id}`);
      if (!api) continue;
      if (api.seriesType() === "Candlestick") {
        api.setData(
          s.candles.map((c) => ({
            time: ut(c.time),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        );
      } else {
        const data = normalize
          ? normalizeLine(s.candles)
          : s.candles.map((c) => ({ time: c.time, value: c.close }));
        api.setData(toLine(data));
      }
    }

    const candles = primary?.candles ?? [];

    // Overlays.
    const setLine = (id: string, pts: LinePoint[]): void => {
      const api = map.get(id);
      if (api) api.setData(toLine(pts));
    };
    if (single && candles.length > 0) {
      if (indicators.has("sma20")) setLine("sma20", sma(candles, 20));
      if (indicators.has("sma50")) setLine("sma50", sma(candles, 50));
      if (indicators.has("ema20")) setLine("ema20", ema(candles, 20));
      if (indicators.has("ema50")) setLine("ema50", ema(candles, 50));
      if (indicators.has("vwap")) setLine("vwap", vwap(candles));
      if (indicators.has("bb")) {
        const bb = bollinger(candles, 20, 2);
        setLine("bb.upper", bb.upper);
        setLine("bb.basis", bb.middle);
        setLine("bb.lower", bb.lower);
      }
    }

    // Panes.
    const rsiData =
      indicators.has("rsi") || indicators.has("divRsi") ? rsi(candles, 14) : [];
    if (indicators.has("rsi")) setLine("rsi", rsiData);
    if (indicators.has("macd")) {
      const m = macd(candles);
      setLine("macd.line", m.macd);
      setLine("macd.signal", m.signal);
      const hist = map.get("macd.hist");
      if (hist) hist.setData(toHist(m.histogram));
    }
    const cvdData =
      indicators.has("cvd") || indicators.has("divCvd") ? cvd(candles) : [];
    if (indicators.has("cvd")) setLine("cvd", cvdData);
    if (indicators.has("ofi")) {
      const api = map.get("ofi");
      if (api) api.setData(toHist(ofi(candles)));
    }
    if (indicators.has("vpin")) setLine("vpin", vpin(candles));

    // Divergence markers (RSI takes precedence, else CVD).
    if (markersRef.current) {
      const osc = indicators.has("divRsi") ? rsiData : cvdData;
      const markers: SeriesMarker<Time>[] = detectDivergences(candles, osc).map(
        (m) => ({
          time: ut(m.time),
          position: m.position,
          color: m.color,
          shape: m.shape,
          text: m.text,
        }),
      );
      markersRef.current.setMarkers(markers);
    }
  }, [series, indicators, normalize, primary, orderFlow]);

  return <div ref={containerRef} className="h-full w-full" />;
}
