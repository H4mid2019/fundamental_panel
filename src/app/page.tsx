"use client";

import { LineChart } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { AIBriefPanel } from "@/components/AIBriefPanel";
import { AssetHeader } from "@/components/AssetHeader";
import { AssetSelector } from "@/components/AssetSelector";
import { ErrorState } from "@/components/ErrorState";
import { FuturesPanel } from "@/components/FuturesPanel";
import { IndicatorGrid } from "@/components/IndicatorGrid";
import { MacroSidebar } from "@/components/MacroSidebar";
import { NewsPanel } from "@/components/NewsPanel";
import { OptionsPanel } from "@/components/OptionsPanel";
import { OrderBookPanel } from "@/components/OrderBookPanel";
import { SentimentChart } from "@/components/SentimentChart";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAIBrief } from "@/hooks/useAIBrief";
import { useAsset } from "@/hooks/useAsset";
import { useIndicators } from "@/hooks/useIndicators";
import { useMacro } from "@/hooks/useMacro";
import { useNews } from "@/hooks/useNews";
import { useOptions } from "@/hooks/useOptions";
import { useOrderBook } from "@/hooks/useOrderBook";
import { usePerformance } from "@/hooks/usePerformance";
import { resolveAssetType } from "@/lib/assets";
import { interpretMacro } from "@/lib/macro";
import type { OptionsChain } from "@/lib/types";

/** Implied volatility of the call nearest the underlying price (ATM IV). */
function atmImpliedVol(chain: OptionsChain): number | null {
  if (chain.underlyingPrice === null) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const c of chain.calls) {
    if (c.impliedVolatility === null) continue;
    const dist = Math.abs(c.strike - chain.underlyingPrice);
    if (dist < bestDist) {
      bestDist = dist;
      best = c.impliedVolatility;
    }
  }
  return best;
}

/** Root dashboard page: asset selection, indicators, AI brief and macro. */
export default function HomePage() {
  const [symbol, setSymbol] = React.useState<string | null>(null);

  const assetType = symbol ? resolveAssetType(symbol) : null;
  const isCrypto = assetType === "crypto";
  const isEquity = assetType === "stock" || assetType === "index";

  const asset = useAsset(symbol);
  const performance = usePerformance(symbol);
  const indicators = useIndicators(symbol);
  const news = useNews(symbol);
  const macro = useMacro();
  const orderbook = useOrderBook(symbol, isCrypto);
  // Default-expiration options (shares the OptionsPanel query) for the AI brief.
  const options = useOptions(symbol, isEquity);

  // Build the extra context fed to the AI brief.
  const macroForAI = React.useMemo(
    () =>
      macro.data?.metrics.map((m) => ({
        label: m.label,
        value: m.value,
        unit: m.unit,
        reading: interpretMacro(m.id, m.value).reading,
      })),
    [macro.data],
  );
  const optionsForAI = React.useMemo(() => {
    if (!isEquity || !options.data) return undefined;
    return {
      putCallRatio: options.data.putCallRatio,
      atmIV: atmImpliedVol(options.data),
    };
  }, [isEquity, options.data]);

  // Call the model once everything that feeds it has settled.
  const settled = (r: { isSuccess: boolean; isError: boolean }) =>
    r.isSuccess || r.isError;
  const aiReady =
    settled(news) &&
    settled(macro) &&
    settled(performance) &&
    (!isEquity || settled(options));

  const brief = useAIBrief(asset.data, indicators.data, aiReady, {
    news: news.data,
    macro: macroForAI,
    performance: performance.data,
    options: optionsForAI,
  });

  // Surface fetch failures as toasts without crashing the UI.
  React.useEffect(() => {
    if (asset.isError) toast.error("Failed to load asset details.");
  }, [asset.isError]);
  React.useEffect(() => {
    if (indicators.isError) toast.error("Failed to load indicators.");
  }, [indicators.isError]);

  return (
    <div className="mx-auto flex w-full flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 2xl:px-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <LineChart className="size-6 text-primary" aria-hidden />
          <h1 className="text-lg font-semibold sm:text-xl">
            Fundamental Analysis Dashboard
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <AssetSelector value={symbol} onSelect={setSymbol} />
          <ThemeToggle />
        </div>
      </header>

      {!symbol ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed p-12 text-center">
          <div className="max-w-md space-y-2">
            <h2 className="text-lg font-medium">Pick an asset to begin</h2>
            <p className="text-sm text-muted-foreground">
              Search for a stock (e.g. AAPL), an index (e.g. ^GSPC) or one of
              the top cryptocurrencies to view its top fundamental indicators
              with AI-generated explanations.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_46rem]">
          <main className="flex flex-col gap-6">
            <AssetHeader
              snapshot={asset.data}
              performance={performance.data}
              isLoading={asset.isLoading}
            />

            <AIBriefPanel
              brief={brief.data}
              isLoading={brief.isLoading && brief.isFetching}
              isError={brief.isError}
              onRetry={() => void brief.refetch()}
            />

            {indicators.isError ? (
              <ErrorState
                title="Couldn't load indicators"
                message="The indicator data failed to load. Please try again."
                onRetry={() => void indicators.refetch()}
              />
            ) : (
              <section aria-label="Fundamental indicators">
                <IndicatorGrid
                  indicators={indicators.data?.indicators ?? []}
                  perIndicator={brief.data?.perIndicator}
                  isLoading={indicators.isLoading}
                />
              </section>
            )}

            {isEquity ? (
              <OptionsPanel key={symbol} symbol={symbol} enabled={isEquity} />
            ) : null}
          </main>

          <aside className="flex min-w-0 flex-col gap-6 2xl:grid 2xl:grid-cols-2 2xl:items-start">
            {/* Mid column: sentiment, order book (crypto), macro, futures. */}
            <div className="flex min-w-0 flex-col gap-6">
              {indicators.data && indicators.data.indicators.length > 0 ? (
                <SentimentChart indicators={indicators.data.indicators} />
              ) : null}
              {isCrypto ? (
                <OrderBookPanel
                  book={orderbook.data}
                  isLoading={orderbook.isLoading}
                  isError={orderbook.isError}
                  onRetry={() => void orderbook.refetch()}
                />
              ) : null}
              <MacroSidebar />
              <FuturesPanel />
            </div>
            {/* Rightmost column: news. */}
            <div className="flex min-w-0 flex-col gap-6">
              <NewsPanel
                news={news.data}
                isLoading={news.isLoading}
                isError={news.isError}
                onRetry={() => void news.refetch()}
              />
            </div>
          </aside>
        </div>
      )}

      <footer className="border-t pt-4 text-center text-xs text-muted-foreground">
        Data is for informational purposes only and is not financial advice.
      </footer>
    </div>
  );
}
