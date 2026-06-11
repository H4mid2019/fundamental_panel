/**
 * Candle data provider: fetches OHLCV bars from Binance, Hyperliquid or Yahoo
 * and normalizes them to {@link Candle}s (UNIX-second times).
 *
 * - Crypto (`binance`): Binance spot klines, which include taker-buy volume so
 *   order-flow studies work; on failure it falls back to Hyperliquid, then to
 *   deterministic fixtures.
 * - Equities/indexes/futures/FX (`yahoo`): `yahoo-finance2` chart, with 4h bars
 *   aggregated from 1h.
 *
 * Every path resolves to a chartable payload — never throws — degrading to
 * fixtures so the chart always renders.
 */

import { z } from "zod";

import {
  INTERVAL_SECONDS,
  providerInterval,
  yahooLookbackDays,
  yahooNeedsAggregation,
} from "../chart/symbols";
import type {
  Candle,
  CandleSeriesPayload,
  CandleSource,
  ChartInterval,
} from "../chart/types";
import { features } from "../env";
import { generateCandles } from "../fixtures/candles";
import { fetchJson } from "../http";
import { logger } from "../logger";

import { yahooFinance } from "./yahoo";

/** Default and maximum number of bars returned. */
export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;

const BINANCE_HOSTS = [
  "https://data-api.binance.vision/api/v3", // market-data mirror (no geo lock)
  "https://api.binance.com/api/v3",
];
const HYPERLIQUID_URL = "https://api.hyperliquid.xyz/info";

/** Build a fixture payload for `(source, symbol, interval)`. */
function fixturePayload(
  source: CandleSource,
  symbol: string,
  interval: ChartInterval,
  limit: number,
): CandleSeriesPayload {
  const step = INTERVAL_SECONDS[interval];
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = nowSec - (nowSec % step);
  return {
    source,
    symbol,
    interval,
    candles: generateCandles(symbol, interval, limit, endSec),
    fallback: true,
    asOf: new Date().toISOString(),
  };
}

const finite = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// --- Binance ---------------------------------------------------------------

// Klines are arrays; index 9 is takerBuyBaseVolume.
const BinanceKlineSchema = z.array(z.array(z.union([z.string(), z.number()])));

function parseBinanceKlines(raw: unknown): Candle[] | null {
  const parsed = BinanceKlineSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.map((k) => ({
    time: Math.floor(finite(k[0]) / 1000),
    open: finite(k[1]),
    high: finite(k[2]),
    low: finite(k[3]),
    close: finite(k[4]),
    volume: finite(k[5]),
    buyVolume: finite(k[9]),
  }));
}

async function fetchBinance(
  symbol: string,
  interval: ChartInterval,
  limit: number,
): Promise<Candle[] | null> {
  const code = providerInterval("binance", interval);
  if (!code) return null;
  const qs = `symbol=${encodeURIComponent(symbol)}&interval=${code}&limit=${limit}`;
  for (const host of BINANCE_HOSTS) {
    const res = await fetchJson<unknown>(`${host}/klines?${qs}`);
    if (res.ok) {
      const candles = parseBinanceKlines(res.data);
      if (candles && candles.length > 0) return candles;
    } else {
      logger.warn("binance.klines failed", { host, symbol, error: res.error });
    }
  }
  return null;
}

// --- Hyperliquid -----------------------------------------------------------

const HlCandleSchema = z.array(
  z.object({
    t: z.number(),
    o: z.union([z.string(), z.number()]),
    h: z.union([z.string(), z.number()]),
    l: z.union([z.string(), z.number()]),
    c: z.union([z.string(), z.number()]),
    v: z.union([z.string(), z.number()]),
  }),
);

/** Derive a Hyperliquid coin from a Binance pair (e.g. `BTCUSDT` → `BTC`). */
export function hyperliquidCoin(binanceSymbol: string): string {
  return binanceSymbol.toUpperCase().replace(/(USDT|USDC|USD|BUSD)$/, "");
}

async function fetchHyperliquid(
  coin: string,
  interval: ChartInterval,
  limit: number,
): Promise<Candle[] | null> {
  const code = providerInterval("hyperliquid", interval);
  if (!code) return null;
  const endTime = Date.now();
  const startTime = endTime - INTERVAL_SECONDS[interval] * 1000 * limit;
  const res = await fetchJson<unknown>(HYPERLIQUID_URL, {
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin, interval: code, startTime, endTime },
      }),
    },
  });
  if (!res.ok) {
    logger.warn("hyperliquid.candle failed", { coin, error: res.error });
    return null;
  }
  const parsed = HlCandleSchema.safeParse(res.data);
  if (!parsed.success) return null;
  return parsed.data.map((k) => ({
    time: Math.floor(k.t / 1000),
    open: finite(k.o),
    high: finite(k.h),
    low: finite(k.l),
    close: finite(k.c),
    volume: finite(k.v),
    // Hyperliquid candles carry no aggressor split.
    buyVolume: null,
  }));
}

// --- Yahoo -----------------------------------------------------------------

/** Aggregate fine bars into coarser ones by a fixed factor (e.g. 1h → 4h). */
export function aggregateCandles(candles: Candle[], factor: number): Candle[] {
  if (factor <= 1) return candles;
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i += factor) {
    const group = candles.slice(i, i + factor);
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) continue;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let hasVol = false;
    for (const b of group) {
      high = Math.max(high, b.high);
      low = Math.min(low, b.low);
      if (b.volume !== null) {
        volume += b.volume;
        hasVol = true;
      }
    }
    out.push({
      time: first.time,
      open: first.open,
      high,
      low,
      close: last.close,
      volume: hasVol ? volume : null,
    });
  }
  return out;
}

const YahooQuoteSchema = z.object({
  date: z.union([z.date(), z.string()]),
  open: z.number().nullable(),
  high: z.number().nullable(),
  low: z.number().nullable(),
  close: z.number().nullable(),
  volume: z.number().nullable(),
});
const YahooChartSchema = z.object({ quotes: z.array(YahooQuoteSchema) });

async function fetchYahoo(
  symbol: string,
  interval: ChartInterval,
  limit: number,
): Promise<Candle[] | null> {
  const aggregate = yahooNeedsAggregation(interval);
  const code = providerInterval("yahoo", interval);
  if (!code) return null;
  const days = yahooLookbackDays(interval);
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const raw: unknown = await yahooFinance.chart(symbol, {
      period1,
      interval: code as "1m" | "5m" | "15m" | "60m" | "1d" | "1wk",
    });
    const parsed = YahooChartSchema.safeParse(raw);
    if (!parsed.success) return null;
    const candles: Candle[] = [];
    for (const q of parsed.data.quotes) {
      if (
        q.open === null ||
        q.high === null ||
        q.low === null ||
        q.close === null
      ) {
        continue;
      }
      const time = q.date instanceof Date ? q.date : new Date(q.date);
      candles.push({
        time: Math.floor(time.getTime() / 1000),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume,
      });
    }
    const result = aggregate ? aggregateCandles(candles, 4) : candles;
    return result.slice(-limit);
  } catch (error) {
    logger.warn("yahoo.chart failed", { symbol, error });
    return null;
  }
}

// --- Dispatcher ------------------------------------------------------------

/**
 * Fetch a normalized candle series for one leg.
 *
 * @param source - Upstream source.
 * @param symbol - Provider-native symbol (e.g. `BTCUSDT`, `^GSPC`).
 * @param interval - Unified timeframe.
 * @param limit - Max bars (clamped to {@link MAX_LIMIT}).
 * @returns A chartable payload; `fallback: true` when fixtures were used.
 */
export async function getCandles(
  source: CandleSource,
  symbol: string,
  interval: ChartInterval,
  limit: number = DEFAULT_LIMIT,
): Promise<CandleSeriesPayload> {
  const bars = Math.min(Math.max(1, limit), MAX_LIMIT);
  if (features.forceFixtures) {
    return fixturePayload(source, symbol, interval, bars);
  }

  let candles: Candle[] | null = null;
  if (source === "binance") {
    candles = await fetchBinance(symbol, interval, bars);
    if (!candles) {
      candles = await fetchHyperliquid(hyperliquidCoin(symbol), interval, bars);
    }
  } else if (source === "hyperliquid") {
    candles = await fetchHyperliquid(symbol, interval, bars);
  } else {
    candles = await fetchYahoo(symbol, interval, bars);
  }

  if (candles && candles.length > 0) {
    // Ensure ascending, de-duplicated times for lightweight-charts.
    const byTime = new Map(candles.map((c) => [c.time, c]));
    const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
    return {
      source,
      symbol,
      interval,
      candles: sorted,
      fallback: false,
      asOf: new Date().toISOString(),
    };
  }

  logger.warn("candles fell back to fixture", { source, symbol, interval });
  return fixturePayload(source, symbol, interval, bars);
}
