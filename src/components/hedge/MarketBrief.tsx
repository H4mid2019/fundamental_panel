"use client";

import { ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import * as React from "react";

import type { HedgeOverview } from "@/app/api/hedge/overview/route";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The whole-market read, above the heatmap.
 *
 * The headline is always visible — it is the one line worth reading before
 * anything else on the page. The three supporting fields are collapsed by
 * default, because a wall of prose above a dashboard trains people to scroll
 * past the dashboard.
 */
export function MarketBrief({
  brief,
}: {
  brief: HedgeOverview["marketBrief"];
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);

  // Before the first scan, or with AI switched off entirely, there is nothing to
  // say — and an empty card that says "no brief" is worse than no card.
  if (!brief) return null;

  return (
    <Card>
      <CardContent className="p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-start gap-2 text-left"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : (
            <ChevronRight
              className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          <Sparkles
            className="mt-0.5 size-4 shrink-0 text-primary"
            aria-hidden
          />
          <span className="flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Market read
              </span>
              {brief.fallback && (
                <Badge variant="neutral" className="px-1 py-0 text-[10px]">
                  offline
                </Badge>
              )}
            </span>
            <span className="mt-0.5 block text-sm font-medium text-foreground">
              {brief.headline}
            </span>
          </span>
        </button>

        {open && (
          <dl className="mt-3 flex flex-col gap-2 border-t pt-3 text-xs">
            <div>
              <dt className="inline text-muted-foreground">Regime: </dt>
              <dd className="inline">{brief.regime}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Opportunities: </dt>
              <dd className="inline">{brief.opportunities}</dd>
            </div>
            <div>
              <dt className="inline text-muted-foreground">Risks: </dt>
              <dd className="inline">{brief.risks}</dd>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {brief.model} · analytical commentary only, not financial advice
            </p>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
