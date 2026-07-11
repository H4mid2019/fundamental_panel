"use client";

import type { HedgeOverview } from "@/app/api/hedge/overview/route";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  pairs: HedgeOverview["pairs"];
}

/**
 * Pair monitor.
 *
 * The half-life is shown next to every z-score, and it is not decoration. A
 * z-score only means "expect a snap-back" if the spread actually mean-reverts; a
 * pair that fails the Ornstein-Uhlenbeck test is displayed with its z-score
 * greyed out and explicitly marked untradeable, because fading a permanently
 * diverging spread is a slow way to lose money.
 */
export function PairMonitor({ pairs }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pair monitor</CardTitle>
        <p className="text-xs text-muted-foreground">
          A z-score is only a signal if the spread mean-reverts. Half-life is
          the test.
        </p>
      </CardHeader>
      <CardContent>
        {pairs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pairs computed yet.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {pairs.map((p) => {
              const z = p.zScore;
              const stretched = z !== null && Math.abs(z) >= 2;

              return (
                <div
                  key={p.pairId}
                  className={cn(
                    "flex flex-col gap-1 rounded-md border p-2.5",
                    p.tradeable
                      ? "border-border"
                      : "border-border/40 opacity-60",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">{p.pairId}</span>
                    <Badge
                      variant={p.tradeable ? "bullish" : "neutral"}
                      className="px-1 py-0 text-[10px]"
                    >
                      {p.tradeable ? "mean-reverting" : "no reversion"}
                    </Badge>
                  </div>

                  <div className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        "text-xl font-semibold tabular-nums",
                        !p.tradeable
                          ? "text-muted-foreground"
                          : stretched
                            ? z > 0
                              ? "text-bearish"
                              : "text-bullish"
                            : "text-foreground",
                      )}
                    >
                      {z === null ? "—" : `${z.toFixed(2)}σ`}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      half-life{" "}
                      {p.halfLife === null
                        ? "n/a"
                        : `${p.halfLife.toFixed(0)}d`}
                    </span>
                  </div>

                  {!p.tradeable && (
                    <p className="text-[10px] text-muted-foreground">
                      {p.halfLife === null
                        ? "Spread does not revert (λ ≥ 0) — this is a trend, not a spread."
                        : `Half-life of ${p.halfLife.toFixed(0)} days is outside the tradeable band.`}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
