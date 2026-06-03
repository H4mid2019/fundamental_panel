"use client";

import { ShieldCheck, Sparkles } from "lucide-react";

import { ErrorState } from "@/components/ErrorState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import type { TradeIdea, AIBrief } from "@/lib/types";

interface AIBriefPanelProps {
  brief?: AIBrief;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

const STANCE_VARIANT: Record<
  TradeIdea["stance"],
  "bullish" | "bearish" | "neutral"
> = {
  long: "bullish",
  short: "bearish",
  avoid: "neutral",
};

const STANCE_LABEL: Record<TradeIdea["stance"], string> = {
  long: "Long",
  short: "Short",
  avoid: "Avoid",
};

const eur = (n: number | null) =>
  n === null
    ? "—"
    : n.toLocaleString("en-US", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 0,
      });

/** The hypothetical trade recommendation block. */
function Recommendation({ rec }: { rec: TradeIdea }) {
  return (
    <div data-testid="ai-recommendation" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STANCE_VARIANT[rec.stance]}>
          {STANCE_LABEL[rec.stance]}
        </Badge>
        {rec.stance !== "avoid" ? (
          <Badge variant="outline" data-testid="ai-best-window">
            Best window ~{rec.bestHorizonMonths} mo
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          within {rec.horizon} · {rec.conviction} conviction
        </span>
      </div>
      <p className="text-sm leading-relaxed text-foreground/90">
        {rec.rationale}
      </p>
      {rec.hedge ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-foreground/80">Hedge: </span>
            {rec.hedge}
          </span>
        </p>
      ) : null}
      {rec.scenario ? (
        <div className="rounded-md border p-2 text-xs">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>
              On {eur(rec.scenario.capitalEur)}:{" "}
              <span className="font-medium text-bullish">
                max gain ≈ {eur(rec.scenario.maxGainEur)}
              </span>
              {" · "}
              <span className="font-medium text-bearish">
                max loss ≈ {eur(rec.scenario.maxLossEur)}
              </span>
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">
            {rec.scenario.assumptions}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Panel rendering the AI summary and a hypothetical trade recommendation. */
export function AIBriefPanel({
  brief,
  isLoading,
  isError,
  onRetry,
}: AIBriefPanelProps) {
  return (
    <Card data-testid="ai-brief">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="size-4 text-primary" aria-hidden />
          AI Brief
        </CardTitle>
        {brief ? (
          <Badge variant={brief.fallback ? "neutral" : "secondary"}>
            {brief.fallback ? "Offline summary" : brief.model}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2" data-testid="ai-brief-loading">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-10/12" />
          </div>
        ) : isError ? (
          <ErrorState
            title="Couldn't generate brief"
            message="The AI brief failed to load."
            onRetry={onRetry}
          />
        ) : brief ? (
          <div className="flex flex-col gap-3">
            <p
              data-testid="ai-brief-summary"
              className="text-sm leading-relaxed text-foreground/90"
            >
              {brief.summary}
            </p>
            <Separator />
            <Recommendation rec={brief.recommendation} />
            <p className="text-[11px] text-muted-foreground">
              Hypothetical, educational analysis — not financial advice.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Select an asset to generate an AI brief.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
