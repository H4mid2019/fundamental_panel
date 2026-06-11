/**
 * Deterministic synthetic candles used for offline development, CI, the chart
 * smoke path and as the graceful fallback when a candle provider fails.
 *
 * The generator is a seeded random walk (no `Math.random`), so a given
 * `(symbol, interval, count, endSec)` always yields identical bars — which the
 * unit tests rely on.
 */

import { INTERVAL_SECONDS } from "../chart/symbols";
import type { Candle, ChartInterval } from "../chart/types";

/** FNV-1a hash → 32-bit seed from a string. */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: deterministic, fast, decent distribution. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rough base price per symbol so fixtures look plausible. */
function basePriceFor(symbol: string): number {
  const s = symbol.toUpperCase();
  if (s.includes("BTC")) return 64000;
  if (s.includes("ETH")) return 3200;
  if (s.includes("SOL")) return 150;
  if (s.includes("BNB")) return 580;
  if (s.includes("XRP")) return 0.52;
  if (s.includes("GSPC") || s.includes("SPX")) return 5200;
  if (s.includes("NDX")) return 18500;
  if (s.includes("GC=F") || s === "GOLD") return 2350;
  if (s.includes("CL=F") || s === "OIL") return 78;
  return 100;
}

/**
 * Generate `count` deterministic OHLCV bars ending at `endSec`.
 *
 * @param symbol - Drives the seed and base price.
 * @param interval - Bar timeframe.
 * @param count - Number of bars.
 * @param endSec - Open time of the last bar (UNIX seconds).
 * @returns Ascending-time candles with synthetic taker-buy volume.
 */
export function generateCandles(
  symbol: string,
  interval: ChartInterval,
  count: number,
  endSec: number,
): Candle[] {
  const step = INTERVAL_SECONDS[interval];
  const rand = mulberry32(hashSeed(`${symbol}:${interval}`));
  const base = basePriceFor(symbol);
  const vol = base * 0.012; // per-bar volatility ~1.2%
  const startSec = endSec - step * (count - 1);

  const out: Candle[] = [];
  let price = base;
  for (let i = 0; i < count; i += 1) {
    const drift = (rand() - 0.5) * 2 * vol;
    const open = price;
    const close = Math.max(0.0001, open + drift);
    const wick = Math.abs(drift) + rand() * vol * 0.5;
    const high = Math.max(open, close) + wick * rand();
    const low = Math.min(open, close) - wick * rand();
    const volume = base * (50 + rand() * 100);
    // Bias buy share with the bar direction so order-flow studies have signal.
    const buyShare = 0.5 + (close >= open ? 0.12 : -0.12) * rand();
    out.push({
      time: startSec + i * step,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: round(volume),
      buyVolume: round(volume * buyShare),
    });
    price = close;
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
