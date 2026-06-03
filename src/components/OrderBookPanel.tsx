"use client";

import { BookOpen } from "lucide-react";

import { ErrorState } from "@/components/ErrorState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { OrderBook, OrderBookLevel } from "@/lib/types";

interface OrderBookPanelProps {
  book?: OrderBook;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

const fmt = (n: number, dp = 2) =>
  n.toLocaleString("en-US", { maximumFractionDigits: dp });

/** One side of the ladder with proportional depth bars. */
function Side({
  levels,
  side,
  maxQty,
}: {
  levels: OrderBookLevel[];
  side: "bid" | "ask";
  maxQty: number;
}) {
  const color = side === "bid" ? "bg-bullish/15" : "bg-bearish/15";
  const text = side === "bid" ? "text-bullish" : "text-bearish";
  return (
    <div className="flex flex-col gap-0.5">
      {levels.map((l, i) => (
        <div
          key={`${side}-${i}`}
          className="relative flex justify-between px-2 py-0.5 text-xs tabular-nums"
        >
          <div
            className={`absolute inset-y-0 right-0 ${color}`}
            style={{
              width: `${maxQty > 0 ? (l.quantity / maxQty) * 100 : 0}%`,
            }}
            aria-hidden
          />
          <span className={`relative ${text}`}>{fmt(l.price, 4)}</span>
          <span className="relative text-muted-foreground">
            {fmt(l.quantity, 3)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Crypto L2 order book ladder with spread and depth imbalance. */
export function OrderBookPanel({
  book,
  isLoading,
  isError,
  onRetry,
}: OrderBookPanelProps) {
  const rows = 10;
  const maxQty = book
    ? Math.max(
        ...book.bids.slice(0, rows).map((l) => l.quantity),
        ...book.asks.slice(0, rows).map((l) => l.quantity),
        0,
      )
    : 0;

  return (
    <Card data-testid="orderbook-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="size-4 text-primary" aria-hidden />
          Order Book
        </CardTitle>
        {book && book.imbalance !== null ? (
          <Badge
            variant={
              book.imbalance > 0.05
                ? "bullish"
                : book.imbalance < -0.05
                  ? "bearish"
                  : "neutral"
            }
          >
            {book.imbalance > 0 ? "+" : ""}
            {(book.imbalance * 100).toFixed(0)}% imbalance
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            title="Couldn't load order book"
            message="The order book failed to load."
            onRetry={onRetry}
          />
        ) : book ? (
          <div className="flex flex-col gap-1">
            <Side
              levels={[...book.asks].slice(0, rows).reverse()}
              side="ask"
              maxQty={maxQty}
            />
            <div className="flex items-center justify-between border-y px-2 py-1 text-xs">
              <span className="font-medium">
                Mid {book.midPrice !== null ? fmt(book.midPrice, 2) : "—"}
              </span>
              <span className="text-muted-foreground">
                Spread{" "}
                {book.spread !== null
                  ? `${fmt(book.spread, 4)} (${book.spreadPct ?? 0}%)`
                  : "—"}
              </span>
            </div>
            <Side
              levels={book.bids.slice(0, rows)}
              side="bid"
              maxQty={maxQty}
            />
            {book.fallback ? (
              <p className="pt-1 text-xs text-muted-foreground">
                Showing sample depth (live via Binance when reachable).
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
