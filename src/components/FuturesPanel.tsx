"use client";

import { Boxes } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useFutures } from "@/hooks/useFutures";
import { formatChange } from "@/lib/format";

/** Sidebar panel listing key futures contracts and their daily change. */
export function FuturesPanel() {
  const { data, isLoading } = useFutures();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Boxes className="size-4 text-primary" aria-hidden />
          Futures
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : (
          <ul className="space-y-2.5">
            {data?.quotes.map((q) => {
              const up = (q.changePct ?? 0) >= 0;
              return (
                <li
                  key={q.symbol}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-muted-foreground">{q.name}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    <span className="font-medium">
                      {q.price !== null
                        ? q.price.toLocaleString("en-US", {
                            maximumFractionDigits: 2,
                          })
                        : "—"}
                    </span>
                    <span
                      className={`w-16 text-right ${up ? "text-bullish" : "text-bearish"}`}
                    >
                      {formatChange(q.changePct)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
