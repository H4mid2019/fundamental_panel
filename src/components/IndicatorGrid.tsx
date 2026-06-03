"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AIPerIndicator, Indicator } from "@/lib/types";

import { IndicatorCard } from "./IndicatorCard";

interface IndicatorGridProps {
  indicators: Indicator[];
  perIndicator?: AIPerIndicator;
  isLoading: boolean;
}

/** Skeleton placeholder grid shown while indicators load. */
function GridSkeleton() {
  return (
    <div
      data-testid="indicator-grid-skeleton"
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4"
    >
      {Array.from({ length: 12 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="p-4 pb-2">
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <Skeleton className="h-7 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Responsive grid of indicator cards with skeleton loading state. */
export function IndicatorGrid({
  indicators,
  perIndicator,
  isLoading,
}: IndicatorGridProps) {
  if (isLoading) return <GridSkeleton />;

  return (
    <div
      data-testid="indicator-grid"
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4"
    >
      {indicators.map((indicator) => (
        <IndicatorCard
          key={indicator.id}
          indicator={indicator}
          aiNote={perIndicator?.[indicator.id]}
        />
      ))}
    </div>
  );
}
