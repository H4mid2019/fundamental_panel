"use client";

import { Bell } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useHedgeAlerts } from "@/hooks/useHedge";

const SEVERITY: Record<string, "bullish" | "neutral" | "bearish"> = {
  info: "neutral",
  warn: "neutral",
  critical: "bearish",
};

/** Reverse-chronological alert feed. */
export function AlertsFeed() {
  const { data, isLoading } = useHedgeAlerts();
  const alerts = data?.alerts ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="size-4 text-primary" aria-hidden />
          Alerts
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No alerts. Note that alerts only fire when a scan runs — there is no
            background watcher.
          </p>
        ) : (
          <ul className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto">
            {alerts.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-1 rounded-md border border-border/60 p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-xs font-medium">{a.title}</span>
                  <div className="flex shrink-0 gap-1">
                    <Badge
                      variant={SEVERITY[a.severity] ?? "neutral"}
                      className="px-1 py-0 text-[10px]"
                    >
                      {a.type.replace(/_/g, " ")}
                    </Badge>
                    {a.proxied && (
                      <Badge
                        variant="neutral"
                        className="px-1 py-0 text-[10px]"
                      >
                        proxied
                      </Badge>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">{a.detail}</p>
                <span className="text-[10px] text-muted-foreground">
                  {new Date(a.createdAt).toLocaleString()}
                  {a.deliveredSlack && " · sent to Slack"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
