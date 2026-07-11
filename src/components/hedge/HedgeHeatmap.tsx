"use client";

import * as React from "react";

import type { HedgeOverview } from "@/app/api/hedge/overview/route";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Ticker = HedgeOverview["tickers"][number];
type Mode = "ivRank" | "skewZ" | "vrp";

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: "ivRank",
    label: "IV rank",
    hint: "Implied vol vs its own trailing range",
  },
  {
    id: "skewZ",
    label: "Skew z-score",
    hint: "25Δ put skew vs its own history",
  },
  {
    id: "vrp",
    label: "VRP",
    hint: "Implied minus realized — is vol rich or cheap versus reality?",
  },
];

/** The value a cell is coloured by, and how to render it. */
function cellValue(t: Ticker, mode: Mode): number | null {
  if (mode === "ivRank") return t.ivRank;
  if (mode === "skewZ") return t.putSkewZ;
  return t.vrp;
}

/**
 * Map a value to a colour.
 *
 * Diverging for the signed measures (skew z-score, VRP) because zero is a
 * meaningful midpoint — rich versus cheap is a sign question. Sequential for IV
 * rank, which runs 0–100 with no natural centre.
 */
function cellClass(value: number | null, mode: Mode): string {
  if (value === null) return "bg-muted/40 text-muted-foreground";

  if (mode === "ivRank") {
    if (value >= 75) return "bg-bearish/80 text-white";
    if (value >= 50) return "bg-bearish/40";
    if (value >= 25) return "bg-bullish/40";
    return "bg-bullish/80 text-white";
  }

  // Signed: positive = rich/elevated, negative = cheap/depressed.
  const magnitude = Math.min(1, Math.abs(value) / (mode === "vrp" ? 5 : 2.5));
  if (magnitude < 0.25) return "bg-muted/60";
  if (value > 0)
    return magnitude > 0.7 ? "bg-bearish/80 text-white" : "bg-bearish/40";
  return magnitude > 0.7 ? "bg-bullish/80 text-white" : "bg-bullish/40";
}

function format(value: number | null, mode: Mode): string {
  if (value === null) return "—";
  if (mode === "ivRank") return value.toFixed(0);
  return value.toFixed(1);
}

interface Props {
  tickers: Ticker[];
}

/** The ticker grid, coloured by IV rank, skew z-score or VRP. */
export function HedgeHeatmap({ tickers }: Props) {
  const [mode, setMode] = React.useState<Mode>("ivRank");
  const active = MODES.find((m) => m.id === mode);

  const sorted = React.useMemo(
    () =>
      [...tickers].sort((a, b) => {
        const av = cellValue(a, mode);
        const bv = cellValue(b, mode);
        if (av === null && bv === null) return a.ticker.localeCompare(b.ticker);
        if (av === null) return 1;
        if (bv === null) return -1;
        return bv - av;
      }),
    [tickers, mode],
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Universe</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{active?.hint}</p>
        </div>
        <div className="flex gap-1">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={cn(
                "rounded-md border px-2 py-1 text-xs transition-colors",
                mode === m.id
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-input text-muted-foreground hover:text-foreground",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </CardHeader>

      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No scan has completed yet. Run one to populate the grid.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-1 sm:grid-cols-5 lg:grid-cols-8 xl:grid-cols-10">
            {sorted.map((t) => {
              const value = cellValue(t, mode);
              // Two independent reasons a cell may be untrustworthy, and they mean
              // different things: `proxied` = the number is a realized-vol
              // stand-in; `poor` = the chain it came from is stale.
              const proxied = mode === "ivRank" && t.ivRankProxied;
              const stale = t.dataQuality === "poor";

              return (
                <div
                  key={t.ticker}
                  title={
                    `${t.ticker}\n` +
                    `IV rank ${format(t.ivRank, "ivRank")}${t.ivRankProxied ? " (proxied)" : ""}\n` +
                    `30d IV ${t.atmIv30?.toFixed(1) ?? "—"}%  EWMA RV ${t.ewmaVol?.toFixed(1) ?? "—"}%\n` +
                    `VRP ${t.vrp?.toFixed(2) ?? "—"}\n` +
                    `Put skew ${t.putSkew25d?.toFixed(2) ?? "—"} (z ${t.putSkewZ?.toFixed(1) ?? "—"})\n` +
                    `Chain: ${t.dataQuality}`
                  }
                  className={cn(
                    "relative flex flex-col items-center rounded-md border border-border/50 px-1 py-1.5 text-center transition-transform hover:scale-105",
                    cellClass(value, mode),
                  )}
                >
                  <span className="text-[11px] font-medium tabular-nums">
                    {t.ticker}
                  </span>
                  <span className="text-[13px] font-semibold tabular-nums">
                    {format(value, mode)}
                  </span>

                  {/* A wrong-but-confident number is worse than a flagged one. */}
                  {(proxied || stale) && (
                    <span
                      className="absolute top-0.5 right-0.5 text-[9px] leading-none"
                      aria-label={proxied ? "proxied" : "stale chain"}
                    >
                      {proxied ? "~" : "!"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          <span>
            <Badge variant="neutral" className="mr-1 px-1 py-0 text-[10px]">
              ~
            </Badge>
            IV rank proxied from realized vol
          </span>
          <span>
            <Badge variant="bearish" className="mr-1 px-1 py-0 text-[10px]">
              !
            </Badge>
            chain data stale — do not trust
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
