"use client";

import { Info } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatIndicatorValue } from "@/lib/format";
import type { Indicator, Sentiment } from "@/lib/types";

const SENTIMENT_VARIANT: Record<
  Sentiment,
  "bullish" | "bearish" | "neutral" | "unknown"
> = {
  bullish: "bullish",
  bearish: "bearish",
  neutral: "neutral",
  unknown: "unknown",
};

const SENTIMENT_LABEL: Record<Sentiment, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
  unknown: "N/A",
};

interface IndicatorCardProps {
  indicator: Indicator;
  aiNote?: string;
}

/** Single fundamental indicator with value, sentiment and AI commentary. */
export function IndicatorCard({ indicator, aiNote }: IndicatorCardProps) {
  return (
    <Card data-testid="indicator-card" className="flex flex-col">
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0 p-4 pb-2">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-muted-foreground">
            {indicator.label}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`About ${indicator.label}`}
                className="rounded text-muted-foreground/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <Info className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent>{indicator.description}</TooltipContent>
          </Tooltip>
        </div>
        <Badge variant={SENTIMENT_VARIANT[indicator.sentiment]}>
          {SENTIMENT_LABEL[indicator.sentiment]}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-1 p-4 pt-0">
        <span className="text-2xl font-semibold tabular-nums">
          {formatIndicatorValue(indicator.value, indicator.format)}
        </span>
        {indicator.sectorAverage !== undefined ? (
          <span className="text-xs text-muted-foreground">
            Sector avg{" "}
            {formatIndicatorValue(indicator.sectorAverage, indicator.format)}
          </span>
        ) : null}
        {aiNote ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {aiNote}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
