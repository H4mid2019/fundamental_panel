"use client";

import { CandlestickChart, ArrowLeft } from "lucide-react";
import Link from "next/link";

import { ChartWorkspace } from "@/components/chart/ChartWorkspace";
import { ThemeToggle } from "@/components/ThemeToggle";

/** Charting workspace: multi-asset, ratio pairs, indicators and live crypto. */
export default function ChartPage(): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 2xl:px-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <CandlestickChart className="size-6 text-primary" aria-hidden />
          <h1 className="text-lg font-semibold sm:text-xl">Charts</h1>
        </div>
        <div className="flex items-center gap-2">
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
        Compare up to four assets or ratio pairs (e.g.{" "}
        <span className="font-medium text-foreground">BTC / GOLD</span>,{" "}
        <span className="font-medium text-foreground">S&amp;P 500 / GOLD</span>)
        on one chart. Crypto streams live from Binance; stocks, indexes, futures
        and FX come from Yahoo Finance.
      </p>

      <ChartWorkspace />

      <footer className="border-t pt-4 text-center text-xs text-muted-foreground">
        Data is for informational purposes only and is not financial advice.
      </footer>
    </div>
  );
}
