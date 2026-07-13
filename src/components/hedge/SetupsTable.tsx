"use client";

import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useHedgeSetups, type HedgeSetup } from "@/hooks/useHedge";
import type { ScannerId } from "@/lib/hedge/scanners/types";
import { cn } from "@/lib/utils";

/** Which stats each scanner shows, in order. */
const COLUMNS: Record<
  ScannerId,
  { key: string; label: string; suffix?: string }[]
> = {
  protectivePut: [
    { key: "ivRank", label: "IV rank" },
    { key: "vrp", label: "VRP" },
    { key: "costPct", label: "Cost", suffix: "%" },
    { key: "annualizedCost", label: "Ann.", suffix: "%" },
    { key: "floorPct", label: "Floor", suffix: "%" },
    { key: "dte", label: "DTE" },
  ],
  putDebitSpread: [
    { key: "putSkewZ", label: "Skew z", suffix: "σ" },
    { key: "netDebit", label: "Debit" },
    { key: "payoffRatio", label: "Payoff", suffix: ":1" },
    { key: "costPct", label: "Cost", suffix: "%" },
    { key: "dte", label: "DTE" },
  ],
  callCredit: [
    { key: "ivRank", label: "IV rank" },
    { key: "credit", label: "Credit" },
    { key: "yieldOnRisk", label: "Yield", suffix: "%" },
    { key: "annualizedYield", label: "Ann.", suffix: "%" },
    { key: "shortDelta", label: "Δ" },
    { key: "dte", label: "DTE" },
  ],
  collar: [
    { key: "ivSpread", label: "C−P IV" },
    { key: "netCostPct", label: "Net", suffix: "%" },
    { key: "floorPct", label: "Floor", suffix: "%" },
    { key: "capPct", label: "Cap", suffix: "%" },
    { key: "annualizedCarry", label: "Carry", suffix: "%" },
    { key: "dte", label: "DTE" },
  ],
  tailHedge: [
    { key: "composite", label: "Composite" },
    { key: "vixSlope", label: "VIX slope", suffix: "%" },
    { key: "spyPutSkew", label: "SPY skew" },
    { key: "costPct", label: "Cost", suffix: "%" },
    { key: "payoffRatio", label: "Payoff", suffix: ":1" },
    { key: "dte", label: "DTE" },
  ],
};

const fmt = (v: number | null | undefined, suffix = ""): string =>
  v === null || v === undefined ? "—" : `${v}${suffix}`;

function SetupRow({
  setup,
  columns,
}: {
  setup: HedgeSetup;
  columns: (typeof COLUMNS)[ScannerId];
}) {
  const [open, setOpen] = React.useState(false);
  const ai = setup.interpretation;

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border/50 hover:bg-accent/40"
        onClick={() => setOpen((o) => !o)}
      >
        <td className="px-2 py-1.5">
          {open ? (
            <ChevronDown
              className="size-3.5 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <ChevronRight
              className="size-3.5 text-muted-foreground"
              aria-hidden
            />
          )}
        </td>
        <td className="px-2 py-1.5 font-medium">
          <span className="inline-flex items-center gap-1">
            {setup.ticker}
            {/* The note lives in the expanded row, so without a marker here the
                only way to find one is to open every row in turn. Only the top
                `ai.topN` setups get interpreted, so most rows have none. */}
            {ai && (
              <Sparkles
                className="size-3 text-primary"
                aria-label="Has an AI interpretation"
              />
            )}
          </span>
        </td>
        <td className="px-2 py-1.5 text-right tabular-nums">
          {setup.score.toFixed(2)}
        </td>
        {columns.map((c) => (
          <td key={c.key} className="px-2 py-1.5 text-right tabular-nums">
            {fmt(setup.stats[c.key], c.suffix)}
          </td>
        ))}
        <td className="px-2 py-1.5">
          <div className="flex flex-wrap justify-end gap-1">
            {setup.proxied && (
              <Badge variant="neutral" className="px-1 py-0 text-[10px]">
                proxied
              </Badge>
            )}
            {setup.ratesFallback && (
              <Badge variant="neutral" className="px-1 py-0 text-[10px]">
                fallback r/q
              </Badge>
            )}
            {setup.dataQuality !== "good" && (
              <Badge
                variant={setup.dataQuality === "poor" ? "bearish" : "neutral"}
                className="px-1 py-0 text-[10px]"
              >
                {setup.dataQuality}
              </Badge>
            )}
            {setup.warnings.length > 0 && (
              <Badge variant="neutral" className="px-1 py-0 text-[10px]">
                <AlertTriangle className="mr-0.5 size-2.5" aria-hidden />
                {setup.warnings.length}
              </Badge>
            )}
          </div>
        </td>
      </tr>

      {open && (
        <tr className="border-b border-border/50 bg-muted/20">
          <td colSpan={columns.length + 4} className="px-4 py-3">
            <div className="flex flex-col gap-3 text-xs">
              <p className="font-medium text-foreground">{setup.summary}</p>

              <div className="flex flex-wrap gap-2">
                {setup.legs.map((l, i) => (
                  <span
                    key={`${l.strike}-${l.right}-${i}`}
                    className={cn(
                      "rounded border px-2 py-1 tabular-nums",
                      l.action === "buy"
                        ? "border-bullish/40 bg-bullish/10"
                        : "border-bearish/40 bg-bearish/10",
                    )}
                  >
                    <span className="font-medium uppercase">{l.action}</span>{" "}
                    {l.expiration} {l.strike}
                    {l.right === "call" ? "C" : "P"} @ {l.mid.toFixed(2)}
                    <span className="ml-1 text-muted-foreground">
                      ({(l.absDelta * 100).toFixed(0)}Δ · IV{" "}
                      {(l.iv * 100).toFixed(1)}% · OI {l.openInterest ?? "—"})
                    </span>
                  </span>
                ))}
              </div>

              {/* Warnings are load-bearing: a top-ranked setup with three of them
                  is not actually the best trade on the board. */}
              {setup.warnings.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {setup.warnings.map((w) => (
                    <li
                      key={w}
                      className="flex items-start gap-1.5 text-bearish"
                    >
                      <AlertTriangle
                        className="mt-0.5 size-3 shrink-0"
                        aria-hidden
                      />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              )}

              {ai && (
                <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background/60 p-3">
                  <p className="flex items-center gap-1.5 font-medium">
                    <Sparkles className="size-3 text-primary" aria-hidden />
                    Interpretation
                    {ai.fallback && (
                      <Badge
                        variant="neutral"
                        className="px-1 py-0 text-[10px]"
                      >
                        offline
                      </Badge>
                    )}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Means: </span>
                    {ai.meaning}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Risk: </span>
                    {ai.risk}
                  </p>
                  <p>
                    <span className="text-muted-foreground">
                      Invalidated if:{" "}
                    </span>
                    {ai.invalidation}
                  </p>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** A sortable, expandable table of one scanner's top setups. */
export function SetupsTable({ scanner }: { scanner: ScannerId }) {
  const { data, isLoading } = useHedgeSetups(scanner);
  const columns = COLUMNS[scanner];

  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-2 pt-6">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </CardContent>
      </Card>
    );
  }

  const setups = data?.setups ?? [];

  return (
    <Card>
      <CardContent className="pt-6">
        {setups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No setups met this scanner&apos;s admission criteria in the last
            scan. That is a result, not an error — the conditions simply are not
            there.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="w-6" />
                  <th className="px-2 py-1.5 text-left font-medium">Ticker</th>
                  <th className="px-2 py-1.5 text-right font-medium">Score</th>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className="px-2 py-1.5 text-right font-medium"
                    >
                      {c.label}
                    </th>
                  ))}
                  <th className="px-2 py-1.5 text-right font-medium">Flags</th>
                </tr>
              </thead>
              <tbody>
                {setups.map((s) => (
                  <SetupRow key={s.signalHash} setup={s} columns={columns} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
