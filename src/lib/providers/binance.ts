import { z } from "zod";

import { features } from "../env";
import { getOrderBookFixture } from "../fixtures";
import { fetchJson } from "../http";
import { logger } from "../logger";
import {
  err,
  ok,
  type AppError,
  type OrderBook,
  type OrderBookLevel,
  type Result,
} from "../types";

const BASE_URL = "https://api.binance.com/api/v3";
const DEPTH_LIMIT = 20;

const DepthSchema = z.object({
  bids: z.array(z.tuple([z.string(), z.string()])),
  asks: z.array(z.tuple([z.string(), z.string()])),
});

export const binanceSchemas = { DepthSchema };

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Parse `[price, qty]` string tuples into numeric levels. */
function parseLevels(
  raw: ReadonlyArray<readonly [string, string]>,
): OrderBookLevel[] {
  const out: OrderBookLevel[] = [];
  for (const [p, q] of raw) {
    const price = Number(p);
    const quantity = Number(q);
    if (Number.isFinite(price) && Number.isFinite(quantity)) {
      out.push({ price, quantity });
    }
  }
  return out;
}

/**
 * Build an {@link OrderBook} from raw bid/ask levels, computing spread and
 * depth imbalance.
 *
 * @param symbol - The asset ticker (e.g. `BTC`).
 * @param bids - Bid levels (descending price).
 * @param asks - Ask levels (ascending price).
 * @param nowMs - Current time in ms since epoch.
 * @param fallback - Whether this was built from fixtures.
 * @returns The assembled order book.
 */
export function computeOrderBook(
  symbol: string,
  bids: OrderBookLevel[],
  asks: OrderBookLevel[],
  nowMs: number,
  fallback: boolean,
): OrderBook {
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const midPrice =
    bestBid !== null && bestAsk !== null
      ? round((bestBid + bestAsk) / 2, 2)
      : null;
  const spread =
    bestBid !== null && bestAsk !== null ? round(bestAsk - bestBid, 4) : null;
  const spreadPct =
    spread !== null && midPrice ? round((spread / midPrice) * 100, 3) : null;

  const bidVol = bids.reduce((a, l) => a + l.quantity, 0);
  const askVol = asks.reduce((a, l) => a + l.quantity, 0);
  const totalVol = bidVol + askVol;
  const imbalance =
    totalVol > 0 ? round((bidVol - askVol) / totalVol, 3) : null;

  return {
    symbol: symbol.toUpperCase(),
    bids,
    asks,
    midPrice,
    spread,
    spreadPct,
    imbalance,
    asOf: new Date(nowMs).toISOString(),
    fallback,
  };
}

/**
 * Fetch a crypto L2 order book from Binance, falling back to fixtures.
 *
 * @param symbol - The coin ticker (e.g. `BTC`).
 * @returns A {@link Result} that resolves to the order book.
 */
export async function getOrderBook(
  symbol: string,
): Promise<Result<OrderBook, AppError>> {
  const now = Date.now();
  const fxBook = getOrderBookFixture(symbol);
  if (features.forceFixtures) {
    if (!fxBook) {
      return err({ code: "NOT_FOUND", message: `No order book for ${symbol}` });
    }
    return ok(computeOrderBook(symbol, fxBook.bids, fxBook.asks, now, true));
  }
  const pair = `${symbol.toUpperCase()}USDT`;
  const result = await fetchJson<unknown>(
    `${BASE_URL}/depth?symbol=${pair}&limit=${DEPTH_LIMIT}`,
  );

  if (result.ok) {
    const parsed = DepthSchema.safeParse(result.data);
    if (parsed.success) {
      return ok(
        computeOrderBook(
          symbol,
          parseLevels(parsed.data.bids),
          parseLevels(parsed.data.asks),
          now,
          false,
        ),
      );
    }
  } else {
    logger.warn("binance.depth failed; using fixture", {
      symbol,
      error: result.error,
    });
  }

  const fx = getOrderBookFixture(symbol);
  if (!fx) {
    return err({ code: "NOT_FOUND", message: `No order book for ${symbol}` });
  }
  return ok(computeOrderBook(symbol, fx.bids, fx.asks, now, true));
}
