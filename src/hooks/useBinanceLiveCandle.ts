"use client";

import * as React from "react";

import { providerInterval } from "@/lib/chart/symbols";
import type { Candle, ChartInterval } from "@/lib/chart/types";

/** Binance market-data-only WS host (no auth, less geo-restricted). */
const WS_HOST = "wss://data-stream.binance.vision/ws";

interface KlinePayload {
  k?: {
    t: number; // bar open time (ms)
    o: string;
    h: string;
    l: string;
    c: string;
    v: string; // base volume
    V: string; // taker buy base volume
  };
}

/**
 * Subscribe to live Binance klines for a single spot symbol and return the
 * latest (possibly still-forming) bar. Reconnects with backoff; cleans up on
 * unmount or dependency change.
 *
 * @param symbol - Binance pair (e.g. `BTCUSDT`), or `null` to disable.
 * @param interval - Unified timeframe.
 * @param enabled - Gates the subscription (e.g. only for single crypto legs).
 * @returns The newest bar, or `null` before the first message.
 */
export function useBinanceLiveCandle(
  symbol: string | null,
  interval: ChartInterval,
  enabled: boolean,
): Candle | null {
  const [candle, setCandle] = React.useState<Candle | null>(null);

  // Reset during render when the subscription target changes (React's
  // "adjust state on prop change" pattern; avoids a setState in the effect).
  const key = `${symbol}:${interval}:${enabled}`;
  const [prevKey, setPrevKey] = React.useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setCandle(null);
  }

  React.useEffect(() => {
    const code = providerInterval("binance", interval);
    if (!enabled || !symbol || !code) return;

    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const connect = (): void => {
      if (closed) return;
      const stream = `${symbol.toLowerCase()}@kline_${code}`;
      ws = new WebSocket(`${WS_HOST}/${stream}`);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as KlinePayload;
          const k = msg.k;
          if (!k) return;
          setCandle({
            time: Math.floor(k.t / 1000),
            open: Number(k.o),
            high: Number(k.h),
            low: Number(k.l),
            close: Number(k.c),
            volume: Number(k.v),
            buyVolume: Number(k.V),
          });
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onopen = () => {
        attempts = 0;
      };
      ws.onclose = () => {
        if (closed) return;
        attempts += 1;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
        retry = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
      ws = null;
    };
  }, [symbol, interval, enabled]);

  return candle;
}
