"use client";

import { TrendingDown, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatChange, formatLargeCurrency } from "@/lib/format";
import type { AssetSnapshot, AssetType, PerformanceReturns } from "@/lib/types";

const TYPE_LABEL: Record<AssetType, string> = {
  stock: "Stock",
  index: "Index",
  crypto: "Crypto",
  commodity: "Commodity",
};

interface AssetHeaderProps {
  snapshot?: AssetSnapshot;
  performance?: PerformanceReturns;
  isLoading: boolean;
}

/** A single trailing-return chip (YTD/1Y/3Y/5Y). */
function ReturnChip({ label, value }: { label: string; value: number | null }) {
  const up = (value ?? 0) >= 0;
  return (
    <div className="flex flex-col rounded-md border px-2.5 py-1.5">
      <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span
        className={`text-sm font-semibold tabular-nums ${
          value === null
            ? "text-muted-foreground"
            : up
              ? "text-bullish"
              : "text-bearish"
        }`}
      >
        {formatChange(value)}
      </span>
    </div>
  );
}

/** Headline panel showing the selected asset's price, returns and metadata. */
export function AssetHeader({
  snapshot,
  performance,
  isLoading,
}: AssetHeaderProps) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 p-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-9 w-32" />
        </CardContent>
      </Card>
    );
  }

  if (!snapshot) return null;

  const up = (snapshot.changePct ?? 0) >= 0;
  const price =
    snapshot.price === null
      ? "—"
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: snapshot.currency || "USD",
          maximumFractionDigits: snapshot.price < 10 ? 4 : 2,
        }).format(snapshot.price);

  return (
    <Card data-testid="asset-header">
      <CardContent className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">{snapshot.name}</h2>
              <Badge variant="secondary">{snapshot.symbol}</Badge>
              <Badge variant="outline">{TYPE_LABEL[snapshot.type]}</Badge>
            </div>
            {snapshot.meta ? (
              <p className="text-sm text-muted-foreground">{snapshot.meta}</p>
            ) : null}
          </div>
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <span className="text-3xl font-bold tabular-nums">{price}</span>
            <span
              className={`flex items-center gap-1 text-sm font-medium ${
                up ? "text-bullish" : "text-bearish"
              }`}
            >
              {up ? (
                <TrendingUp className="size-4" aria-hidden />
              ) : (
                <TrendingDown className="size-4" aria-hidden />
              )}
              {formatChange(snapshot.changePct)} today
            </span>
            {snapshot.marketCap !== null ? (
              <span className="text-xs text-muted-foreground">
                Market cap {formatLargeCurrency(snapshot.marketCap)}
              </span>
            ) : null}
          </div>
        </div>

        <div
          data-testid="performance-returns"
          className="grid grid-cols-4 gap-2"
        >
          <ReturnChip label="YTD" value={performance?.ytd ?? null} />
          <ReturnChip label="1Y" value={performance?.oneY ?? null} />
          <ReturnChip label="3Y" value={performance?.threeY ?? null} />
          <ReturnChip label="5Y" value={performance?.fiveY ?? null} />
        </div>
      </CardContent>
    </Card>
  );
}
