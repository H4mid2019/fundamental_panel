"use client";

import { Users } from "lucide-react";
import * as React from "react";

import { ErrorState } from "@/components/ErrorState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { usePeers } from "@/hooks/usePeers";
import { formatIndicatorValue } from "@/lib/format";
import type { PeerGroupId, PeerMetricRow } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PeerBenchmarksPanelProps {
  symbol: string;
  enabled: boolean;
}

/** Color the asset's value by how it compares to the peer median. */
function valueTone(row: PeerMetricRow): string {
  if (
    row.betterWhen === null ||
    row.value === null ||
    row.peerMedian === null ||
    row.value === row.peerMedian
  ) {
    return "";
  }
  const better =
    row.betterWhen === "higher"
      ? row.value > row.peerMedian
      : // A negative valuation ratio signals losses, never cheapness.
        row.value < row.peerMedian && row.value >= 0;
  return better ? "text-bullish" : "text-bearish";
}

/** Peer-benchmark comparison: tabbed metric groups vs peer median and sector. */
export function PeerBenchmarksPanel({
  symbol,
  enabled,
}: PeerBenchmarksPanelProps) {
  const [tab, setTab] = React.useState<PeerGroupId>("quote");
  const { data, isLoading, isError, refetch } = usePeers(symbol, enabled);

  const group =
    data?.groups.find((g) => g.id === tab) ?? data?.groups[0] ?? null;

  return (
    <Card data-testid="peer-benchmarks-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="size-4 text-primary" aria-hidden />
          Peer Benchmarks
        </CardTitle>
        {data && data.peers.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            vs {data.peers.map((p) => p.symbol).join(" / ")}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : isError ? (
          <ErrorState
            title="Couldn't load peer benchmarks"
            message="The peer comparison failed to load."
            onRetry={() => void refetch()}
          />
        ) : data && group ? (
          <div className="flex flex-col gap-3">
            <div
              role="tablist"
              aria-label="Peer benchmark groups"
              className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1"
            >
              {data.groups.map((g) => (
                <button
                  key={g.id}
                  role="tab"
                  aria-selected={g.id === group.id}
                  onClick={() => setTab(g.id)}
                  className={cn(
                    "flex-1 rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
                    g.id === group.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {g.label}
                </button>
              ))}
            </div>

            <table className="w-full text-sm tabular-nums">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1.5 text-left font-medium">Metric</th>
                  <th className="py-1.5 text-right font-medium">
                    {data.symbol}
                  </th>
                  <th className="py-1.5 text-right font-medium">Peers</th>
                  <th className="py-1.5 text-right font-medium">Sector</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.id} className="border-t border-border/60">
                    <td className="py-2 pr-2 text-left text-muted-foreground">
                      {row.label}
                    </td>
                    <td
                      className={cn(
                        "py-2 text-right font-medium",
                        valueTone(row),
                      )}
                    >
                      {formatIndicatorValue(row.value, row.format)}
                    </td>
                    <td className="py-2 text-right">
                      {formatIndicatorValue(row.peerMedian, row.format)}
                    </td>
                    <td className="py-2 text-right text-muted-foreground">
                      {formatIndicatorValue(row.sectorAvg, row.format)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {data.fallback ? (
              <p className="text-xs text-muted-foreground">
                Peer data is limited right now; medians may be unavailable.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No peer data available.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
