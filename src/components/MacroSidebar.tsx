"use client";

import { Activity, Info } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useMacro } from "@/hooks/useMacro";
import { interpretMacro } from "@/lib/macro";
import type { MacroMetric, MacroReading } from "@/lib/types";

const READING_TEXT: Record<MacroReading, string> = {
  good: "text-bullish",
  bad: "text-bearish",
  neutral: "text-neutral",
  unknown: "text-muted-foreground",
};

const READING_DOT: Record<MacroReading, string> = {
  good: "bg-bullish",
  bad: "bg-bearish",
  neutral: "bg-neutral",
  unknown: "bg-muted-foreground",
};

/** Format a macro metric value with its unit. */
function formatMetric(metric: MacroMetric): string {
  if (metric.value === null) return "—";
  return `${metric.value}${metric.unit}`;
}

/** Sidebar listing key macro indicators with risk-asset color + context. */
export function MacroSidebar() {
  const { data, isLoading } = useMacro();

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 text-primary" aria-hidden />
          Macro
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Color = read for risk assets (green = supportive, red = headwind).
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))
        ) : (
          <ul className="space-y-3">
            {data?.metrics.map((metric, index) => {
              const { reading, description, note } = interpretMacro(
                metric.id,
                metric.value,
              );
              return (
                <li key={metric.id}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span
                        className={`size-2 shrink-0 rounded-full ${READING_DOT[reading]}`}
                        aria-hidden
                      />
                      {metric.label}
                      {description ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={`About ${metric.label}`}
                              className="text-muted-foreground/70 hover:text-foreground"
                            >
                              <Info className="size-3" aria-hidden />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="font-medium">{description}</p>
                            {note ? <p className="mt-1">{note}</p> : null}
                          </TooltipContent>
                        </Tooltip>
                      ) : null}
                    </span>
                    <span
                      className={`font-medium tabular-nums ${READING_TEXT[reading]}`}
                    >
                      {formatMetric(metric)}
                    </span>
                  </div>
                  {index < (data?.metrics.length ?? 0) - 1 ? (
                    <Separator className="mt-3" />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
