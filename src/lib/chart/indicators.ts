/**
 * Pure technical-indicator math operating on {@link Candle} arrays.
 *
 * Price studies (SMA/EMA/Bollinger/VWAP/RSI/MACD) work on any series. Order-flow
 * studies (CVD/OFI/VPIN) require per-bar taker-buy volume (`candle.buyVolume`,
 * currently Binance only) and return an empty array when it is absent.
 *
 * Output points use UNIX-second times so they drop straight into
 * `lightweight-charts` line/histogram series.
 */

import type { Candle } from "./types";

/** A `{ time, value }` point for a line series. */
export interface LinePoint {
  time: number;
  value: number;
}

/** A histogram point with an optional per-bar color. */
export interface HistPoint {
  time: number;
  value: number;
  color?: string;
}

/** A divergence annotation, mapped 1:1 to a `lightweight-charts` marker. */
export interface DivergenceMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown";
  text: string;
  kind: "bullish" | "bearish" | "hiddenBullish" | "hiddenBearish";
}

const UP = "#26a69a";
const DOWN = "#ef5350";

const closes = (c: readonly Candle[]): number[] => c.map((b) => b.close);

/** Simple moving average of `close`. */
export function sma(candles: readonly Candle[], period: number): LinePoint[] {
  if (period <= 0) return [];
  const out: LinePoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const cur = candles[i];
    if (!cur) continue;
    sum += cur.close;
    const drop = candles[i - period];
    if (drop) sum -= drop.close;
    if (i >= period - 1) out.push({ time: cur.time, value: sum / period });
  }
  return out;
}

/**
 * Exponential moving average over an array, aligned to the input length.
 * Entries before the seed (SMA of the first `period` values) are `null`.
 */
function emaRaw(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i] ?? 0;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] ?? prev) * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Exponential moving average of `close`. */
export function ema(candles: readonly Candle[], period: number): LinePoint[] {
  const raw = emaRaw(closes(candles), period);
  const out: LinePoint[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const v = raw[i];
    const bar = candles[i];
    if (v !== null && v !== undefined && bar) {
      out.push({ time: bar.time, value: v });
    }
  }
  return out;
}

/** Bollinger Bands (SMA basis ± `mult`·σ). */
export function bollinger(
  candles: readonly Candle[],
  period = 20,
  mult = 2,
): { upper: LinePoint[]; middle: LinePoint[]; lower: LinePoint[] } {
  const upper: LinePoint[] = [];
  const middle: LinePoint[] = [];
  const lower: LinePoint[] = [];
  for (let i = period - 1; i < candles.length; i += 1) {
    const cur = candles[i];
    if (!cur) continue;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j += 1) sum += candles[j]?.close ?? 0;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = (candles[j]?.close ?? mean) - mean;
      variance += d * d;
    }
    const sd = Math.sqrt(variance / period);
    middle.push({ time: cur.time, value: mean });
    upper.push({ time: cur.time, value: mean + mult * sd });
    lower.push({ time: cur.time, value: mean - mult * sd });
  }
  return { upper, middle, lower };
}

/**
 * Volume-weighted average price, reset each UTC day (session VWAP). Bars without
 * volume contribute nothing. Returns `[]` when no bar carries volume.
 */
export function vwap(candles: readonly Candle[]): LinePoint[] {
  const out: LinePoint[] = [];
  let day = NaN;
  let cumPV = 0;
  let cumVol = 0;
  let any = false;
  for (const bar of candles) {
    const d = Math.floor(bar.time / 86_400);
    if (d !== day) {
      day = d;
      cumPV = 0;
      cumVol = 0;
    }
    const vol = bar.volume ?? 0;
    if (vol > 0) {
      const typical = (bar.high + bar.low + bar.close) / 3;
      cumPV += typical * vol;
      cumVol += vol;
      any = true;
    }
    if (cumVol > 0) out.push({ time: bar.time, value: cumPV / cumVol });
  }
  return any ? out : [];
}

/** Wilder's RSI of `close`. */
export function rsi(candles: readonly Candle[], period = 14): LinePoint[] {
  if (candles.length <= period) return [];
  const out: LinePoint[] = [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (!cur || !prev) continue;
    const ch = cur.close - prev.close;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const rsiAt = (): number =>
    avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const seedBar = candles[period];
  if (seedBar) out.push({ time: seedBar.time, value: rsiAt() });
  for (let i = period + 1; i < candles.length; i += 1) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (!cur || !prev) continue;
    const ch = cur.close - prev.close;
    const g = ch >= 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out.push({ time: cur.time, value: rsiAt() });
  }
  return out;
}

/** MACD line, signal line and histogram. */
export function macd(
  candles: readonly Candle[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): { macd: LinePoint[]; signal: LinePoint[]; histogram: HistPoint[] } {
  const c = closes(candles);
  const emaFast = emaRaw(c, fast);
  const emaSlow = emaRaw(c, slow);
  const macdLine: LinePoint[] = [];
  const macdVals: number[] = [];
  const macdTimes: number[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const f = emaFast[i];
    const s = emaSlow[i];
    const bar = candles[i];
    if (
      f === null ||
      f === undefined ||
      s === null ||
      s === undefined ||
      !bar
    ) {
      continue;
    }
    macdLine.push({ time: bar.time, value: f - s });
    macdVals.push(f - s);
    macdTimes.push(bar.time);
  }
  const signalRaw = emaRaw(macdVals, signalPeriod);
  const signal: LinePoint[] = [];
  const histogram: HistPoint[] = [];
  for (let j = 0; j < signalRaw.length; j += 1) {
    const sig = signalRaw[j];
    const time = macdTimes[j];
    const val = macdVals[j];
    if (
      sig === null ||
      sig === undefined ||
      time === undefined ||
      val === undefined
    ) {
      continue;
    }
    const h = val - sig;
    signal.push({ time, value: sig });
    histogram.push({ time, value: h, color: h >= 0 ? UP : DOWN });
  }
  return { macd: macdLine, signal, histogram };
}

/** Per-bar signed taker volume (buy − sell), or `null` without buy volume. */
function barDelta(bar: Candle): number | null {
  if (bar.buyVolume === null || bar.buyVolume === undefined) return null;
  const vol = bar.volume ?? 0;
  return 2 * bar.buyVolume - vol; // buy − (vol − buy)
}

/** True when at least one bar carries taker-buy volume (order-flow capable). */
export function hasOrderFlow(candles: readonly Candle[]): boolean {
  return candles.some((b) => b.buyVolume !== null && b.buyVolume !== undefined);
}

/** Cumulative Volume Delta (running sum of per-bar buy − sell). */
export function cvd(candles: readonly Candle[]): LinePoint[] {
  if (!hasOrderFlow(candles)) return [];
  const out: LinePoint[] = [];
  let cum = 0;
  for (const bar of candles) {
    const d = barDelta(bar);
    if (d !== null) cum += d;
    out.push({ time: bar.time, value: cum });
  }
  return out;
}

/**
 * Trade-based Order-Flow Imbalance per bar, normalized to [-1, 1]:
 * (buy − sell) / (buy + sell).
 */
export function ofi(candles: readonly Candle[]): HistPoint[] {
  if (!hasOrderFlow(candles)) return [];
  const out: HistPoint[] = [];
  for (const bar of candles) {
    const d = barDelta(bar);
    const vol = bar.volume ?? 0;
    if (d === null || vol === 0) continue;
    const value = d / vol;
    out.push({ time: bar.time, value, color: value >= 0 ? UP : DOWN });
  }
  return out;
}

/**
 * VPIN (volume-synchronized probability of informed trading).
 *
 * Bars are packed into equal-volume buckets; per bucket we accumulate actual
 * taker buy/sell volume (no bulk-volume classification needed since the source
 * tags aggressor side). VPIN is the rolling mean of |buy − sell| / bucketVolume
 * over the last `window` buckets, plotted at each bucket's closing bar time.
 *
 * @param window - Number of buckets in the rolling average (default 50). It is
 *   clamped to the bucket count so a short series still produces output.
 * @param bucketsTarget - Approximate number of buckets to split the series into.
 *   Must comfortably exceed `window` or no points are emitted.
 */
export function vpin(
  candles: readonly Candle[],
  window = 50,
  bucketsTarget = 200,
): LinePoint[] {
  if (!hasOrderFlow(candles)) return [];
  const totalVol = candles.reduce((a, b) => a + (b.volume ?? 0), 0);
  if (totalVol <= 0) return [];
  const bucketVol = totalVol / Math.max(1, bucketsTarget);

  interface Bucket {
    buy: number;
    sell: number;
    vol: number;
    time: number;
  }
  const buckets: Bucket[] = [];
  const firstBar = candles[0];
  let cur: Bucket = { buy: 0, sell: 0, vol: 0, time: firstBar?.time ?? 0 };

  for (const bar of candles) {
    const vol = bar.volume ?? 0;
    if (vol <= 0 || bar.buyVolume === null || bar.buyVolume === undefined) {
      continue;
    }
    const buy = bar.buyVolume;
    const sell = Math.max(0, vol - buy);
    cur.buy += buy;
    cur.sell += sell;
    cur.vol += vol;
    cur.time = bar.time;
    if (cur.vol >= bucketVol) {
      buckets.push(cur);
      cur = { buy: 0, sell: 0, vol: 0, time: bar.time };
    }
  }

  // Clamp the rolling window so a series with few buckets still emits points.
  const w = Math.min(window, buckets.length);
  if (w < 1) return [];

  const out: LinePoint[] = [];
  for (let i = 0; i < buckets.length; i += 1) {
    const end = buckets[i];
    if (!end || i + 1 < w) continue;
    let imbalance = 0;
    let vol = 0;
    for (let j = i - w + 1; j <= i; j += 1) {
      const b = buckets[j];
      if (!b) continue;
      imbalance += Math.abs(b.buy - b.sell);
      vol += b.vol;
    }
    if (vol > 0) out.push({ time: end.time, value: imbalance / vol });
  }
  return out;
}

/** Pivot indices where `values[i]` is a local extreme over `left`/`right` bars. */
function pivots(
  values: readonly number[],
  left: number,
  right: number,
  high: boolean,
): number[] {
  const out: number[] = [];
  for (let i = left; i < values.length - right; i += 1) {
    const v = values[i];
    if (v === undefined) continue;
    let isPivot = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      const w = values[j];
      if (w === undefined) continue;
      if (high ? w >= v : w <= v) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) out.push(i);
  }
  return out;
}

/**
 * Detect regular and hidden RSI/CVD-vs-price divergences via pivot comparison.
 *
 * @param candles - Price series.
 * @param oscillator - The oscillator line (e.g. {@link rsi} or {@link cvd}),
 *   aligned by time.
 * @param opts - Pivot lookback (`left`/`right`) and max pivot separation.
 * @returns Markers at the confirming (second) pivot of each divergence.
 */
export function detectDivergences(
  candles: readonly Candle[],
  oscillator: readonly LinePoint[],
  opts: { left?: number; right?: number; maxBars?: number } = {},
): DivergenceMarker[] {
  const { left = 5, right = 5, maxBars = 60 } = opts;
  if (candles.length < left + right + 2 || oscillator.length === 0) return [];

  const oscByTime = new Map(oscillator.map((p) => [p.time, p.value]));
  const highs = candles.map((b) => b.high);
  const lows = candles.map((b) => b.low);
  const out: DivergenceMarker[] = [];

  const oscAt = (i: number): number | undefined => {
    const bar = candles[i];
    return bar ? oscByTime.get(bar.time) : undefined;
  };
  const timeAt = (i: number): number | undefined => candles[i]?.time;

  // Bearish divergences compare consecutive pivot highs.
  const highPivots = pivots(highs, left, right, true);
  for (let k = 1; k < highPivots.length; k += 1) {
    const a = highPivots[k - 1];
    const b = highPivots[k];
    if (a === undefined || b === undefined || b - a > maxBars) continue;
    const ha = highs[a];
    const hb = highs[b];
    const oa = oscAt(a);
    const ob = oscAt(b);
    const tb = timeAt(b);
    if (
      ha === undefined ||
      hb === undefined ||
      oa === undefined ||
      ob === undefined ||
      tb === undefined
    ) {
      continue;
    }
    if (hb > ha && ob < oa) out.push(marker(tb, "bearish"));
    else if (hb < ha && ob > oa) out.push(marker(tb, "hiddenBearish"));
  }

  // Bullish divergences compare consecutive pivot lows.
  const lowPivots = pivots(lows, left, right, false);
  for (let k = 1; k < lowPivots.length; k += 1) {
    const a = lowPivots[k - 1];
    const b = lowPivots[k];
    if (a === undefined || b === undefined || b - a > maxBars) continue;
    const la = lows[a];
    const lb = lows[b];
    const oa = oscAt(a);
    const ob = oscAt(b);
    const tb = timeAt(b);
    if (
      la === undefined ||
      lb === undefined ||
      oa === undefined ||
      ob === undefined ||
      tb === undefined
    ) {
      continue;
    }
    if (lb < la && ob > oa) out.push(marker(tb, "bullish"));
    else if (lb > la && ob < oa) out.push(marker(tb, "hiddenBullish"));
  }

  return out.sort((x, y) => x.time - y.time);
}

function marker(
  time: number,
  kind: DivergenceMarker["kind"],
): DivergenceMarker {
  const bearish = kind === "bearish" || kind === "hiddenBearish";
  const hidden = kind.startsWith("hidden");
  return {
    time,
    position: bearish ? "aboveBar" : "belowBar",
    color: bearish ? DOWN : UP,
    shape: bearish ? "arrowDown" : "arrowUp",
    text: `${hidden ? "H" : ""}${bearish ? "Bear" : "Bull"}`,
    kind,
  };
}
