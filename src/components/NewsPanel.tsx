"use client";

import { Newspaper } from "lucide-react";

import { ErrorState } from "@/components/ErrorState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { NewsAnalysis, NewsEventType, NewsSentiment } from "@/lib/types";

const EVENT_LABEL: Record<NewsEventType, string> = {
  leadership: "Leadership",
  ma: "M&A",
  earnings: "Earnings",
  guidance: "Guidance",
  legal: "Legal",
  layoffs: "Layoffs",
  partnership: "Partnership",
  product: "Product",
  dividend: "Dividend",
  buyback: "Buyback",
  analyst: "Analyst",
  regulatory: "Regulatory",
  other: "News",
};

const SENTIMENT_VARIANT: Record<
  NewsSentiment,
  "bullish" | "bearish" | "neutral"
> = {
  positive: "bullish",
  negative: "bearish",
  neutral: "neutral",
};

interface NewsPanelProps {
  news?: NewsAnalysis;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

/** Format an ISO timestamp as a short relative age (e.g. "3d ago"). */
function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  return "just now";
}

/** Panel showing the weighted news index and top headlines for an asset. */
export function NewsPanel({
  news,
  isLoading,
  isError,
  onRetry,
}: NewsPanelProps) {
  return (
    <Card data-testid="news-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Newspaper className="size-4 text-primary" aria-hidden />
          News
        </CardTitle>
        {news ? (
          <div className="flex items-center gap-2">
            <span
              data-testid="news-index"
              className="text-sm font-semibold tabular-nums"
            >
              Index {news.index > 0 ? `+${news.index}` : news.index}
            </span>
            <Badge variant={SENTIMENT_VARIANT[news.label]}>{news.label}</Badge>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            title="Couldn't load news"
            message="The news feed failed to load."
            onRetry={onRetry}
          />
        ) : news && news.articles.length > 0 ? (
          <ul className="space-y-3">
            {news.articles.map((a) => (
              <li key={a.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="shrink-0">
                    {EVENT_LABEL[a.eventType]}
                  </Badge>
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      a.sentiment === "positive"
                        ? "bg-bullish"
                        : a.sentiment === "negative"
                          ? "bg-bearish"
                          : "bg-neutral"
                    }`}
                    aria-label={a.sentiment}
                  />
                </div>
                {a.url ? (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm leading-snug font-medium hover:underline"
                  >
                    {a.title}
                  </a>
                ) : (
                  <span className="text-sm leading-snug font-medium">
                    {a.title}
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  {a.source} · {timeAgo(a.publishedAt)} · weight{" "}
                  {a.weight.toFixed(2)}
                </span>
              </li>
            ))}
            {news.fallback ? (
              <li className="pt-1 text-xs text-muted-foreground">
                Showing sample news (set FINNHUB_API_KEY for live coverage).
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No recent news found.</p>
        )}
      </CardContent>
    </Card>
  );
}
