"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ResponsiveContainer,
  XAxis,
} from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { sentimentBreakdown } from "@/lib/indicators/score";
import type { Indicator } from "@/lib/types";

interface SentimentChartProps {
  indicators: Indicator[];
}

/**
 * Weighted distribution of indicator sentiment.
 *
 * Each indicator contributes a score weighted by its category importance and
 * how far its value sits past the bullish/bearish threshold (conviction), so a
 * deeply-bullish ROE counts more than a marginally-bullish one. Indicators with
 * no value are reported separately as "not available".
 */
export function SentimentChart({ indicators }: SentimentChartProps) {
  const breakdown = React.useMemo(
    () => sentimentBreakdown(indicators),
    [indicators],
  );

  const data = [
    { label: "Bullish", color: "var(--bullish)", score: breakdown.bullish },
    { label: "Neutral", color: "var(--neutral)", score: breakdown.neutral },
    { label: "Bearish", color: "var(--bearish)", score: breakdown.bearish },
  ];

  return (
    <Card data-testid="sentiment-chart">
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">Sentiment distribution</CardTitle>
        <p className="text-xs text-muted-foreground">
          Weighted by category &amp; conviction · {breakdown.scored} scored
          {breakdown.unknown > 0 ? ` · ${breakdown.unknown} N/A` : ""}
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-40 w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={data} margin={{ top: 16, bottom: 0 }}>
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                fontSize={12}
                stroke="var(--muted-foreground)"
              />
              <Bar dataKey="score" radius={[6, 6, 0, 0]}>
                <LabelList dataKey="score" position="top" fontSize={12} />
                {data.map((entry) => (
                  <Cell key={entry.label} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
