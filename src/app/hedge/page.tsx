"use client";

import { ArrowLeft, Loader2, Play, Shield } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { toast } from "sonner";

import { AlertsFeed } from "@/components/hedge/AlertsFeed";
import { HedgeContextBar } from "@/components/hedge/HedgeContextBar";
import { HedgeHeatmap } from "@/components/hedge/HedgeHeatmap";
import { PairMonitor } from "@/components/hedge/PairMonitor";
import { SetupsTable } from "@/components/hedge/SetupsTable";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useHedgeOverview, useRunScan } from "@/hooks/useHedge";
import {
  SCANNER_IDS,
  SCANNER_LABELS,
  type ScannerId,
} from "@/lib/hedge/scanners/types";
import { cn } from "@/lib/utils";

/** HedgeScope: options-market monitoring and hedging setups. */
export default function HedgePage(): React.JSX.Element {
  const { data: overview, isLoading } = useHedgeOverview();
  const [tab, setTab] = React.useState<ScannerId>("collar");
  const [secret, setSecret] = React.useState("");
  const runScan = useRunScan();

  const onScan = (): void => {
    runScan.mutate(secret, {
      onSuccess: () =>
        toast.success("Scan started", {
          description:
            "A full scan takes a few minutes. The dashboard refreshes as it lands.",
        }),
      onError: (error: Error) =>
        toast.error("Could not start scan", {
          description: error.message,
        }),
    });
  };

  const scan = overview?.scan;

  return (
    <div className="mx-auto flex w-full flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 2xl:px-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Shield className="size-6 text-primary" aria-hidden />
          <h1 className="text-lg font-semibold sm:text-xl">HedgeScope</h1>
          {scan && (
            <span className="ml-2 text-xs text-muted-foreground">
              last scan{" "}
              {new Date(scan.finishedAt ?? scan.startedAt).toLocaleString()} ·{" "}
              {scan.status} · {scan.tickersOk} ok
              {scan.tickersFailed > 0 && `, ${scan.tickersFailed} skipped`}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Input
            type="password"
            placeholder="Scan secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="h-8 w-32 text-xs"
            aria-label="Scan secret"
          />
          <Button
            size="sm"
            onClick={onScan}
            disabled={runScan.isPending || secret.length === 0}
          >
            {runScan.isPending ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="mr-1 size-3.5" aria-hidden />
            )}
            Run scan
          </Button>
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Dashboard
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <p className="text-sm text-muted-foreground">
        Scans a universe of optionable tickers for hedging setups. Every number
        is computed from the bid/ask midpoint with a locally-solved implied
        volatility — never the feed&apos;s own, which is derived from a stale
        last trade.{" "}
        <span className="text-foreground">
          Analytical commentary only; not financial advice.
        </span>
      </p>

      {isLoading || !overview ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          <HedgeContextBar overview={overview} />
          <HedgeHeatmap tickers={overview.tickers} />

          <div>
            <div className="mb-2 flex flex-wrap gap-1">
              {SCANNER_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs transition-colors",
                    tab === id
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-input text-muted-foreground hover:text-foreground",
                  )}
                >
                  {SCANNER_LABELS[id]}
                </button>
              ))}
            </div>
            <SetupsTable scanner={tab} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <PairMonitor pairs={overview.pairs} />
            <AlertsFeed />
          </div>
        </>
      )}

      <footer className="border-t pt-4 text-center text-xs text-muted-foreground">
        Alerts fire only when a scan runs. With no Slack webhook configured
        there is no notification when this tab is closed.
      </footer>
    </div>
  );
}
