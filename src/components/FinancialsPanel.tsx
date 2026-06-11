"use client";

import { Landmark } from "lucide-react";
import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useFinancials } from "@/hooks/useFinancials";
import { STATEMENT_LINE_ITEMS, type StatementLineItem } from "@/lib/financials";
import { formatLargeCurrency } from "@/lib/format";
import type {
  StatementFrequency,
  StatementKind,
  StatementPeriod,
} from "@/lib/types";
import { cn } from "@/lib/utils";

interface FinancialsPanelProps {
  symbol: string;
  enabled: boolean;
}

/** The two bar series charted per statement. */
const CHART_SERIES: Record<
  StatementKind,
  { aKey: string; aLabel: string; bKey: string; bLabel: string }
> = {
  income: {
    aKey: "totalRevenue",
    aLabel: "Revenue",
    bKey: "netIncome",
    bLabel: "Net Income",
  },
  balance: {
    aKey: "totalAssets",
    aLabel: "Total Assets",
    bKey: "totalLiabilitiesNetMinorityInterest",
    bLabel: "Total Liabilities",
  },
  cashflow: {
    aKey: "operatingCashFlow",
    aLabel: "Operating CF",
    bKey: "freeCashFlow",
    bLabel: "Free CF",
  },
};

const SECTION_TITLES: Record<StatementKind, string> = {
  income: "Income statement",
  balance: "Balance Sheet",
  cashflow: "Cash flow",
};

/** Format a statement cell according to its line item's display style. */
function formatCell(value: number | null, item: StatementLineItem): string {
  if (value === null || !Number.isFinite(value)) return "—";
  switch (item.format) {
    case "largeCurrency":
      return formatLargeCurrency(value);
    case "currency":
      return `$${value.toFixed(2)}`;
    case "number":
      return value.toLocaleString("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      });
  }
}

/** Annual/Quarterly segmented toggle. */
function FrequencyToggle({
  value,
  onChange,
}: {
  value: StatementFrequency;
  onChange: (next: StatementFrequency) => void;
}) {
  return (
    <div className="flex rounded-full bg-muted p-0.5 text-xs">
      {(["annual", "quarterly"] as const).map((f) => (
        <button
          key={f}
          onClick={() => onChange(f)}
          aria-pressed={value === f}
          className={cn(
            "rounded-full px-3 py-1 font-medium capitalize transition-colors",
            value === f
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {f}
        </button>
      ))}
    </div>
  );
}

/** Full-statement table shown inside the "See all" dialog. */
function StatementTable({
  kind,
  periods,
}: {
  kind: StatementKind;
  periods: StatementPeriod[];
}) {
  const items = STATEMENT_LINE_ITEMS[kind];
  return (
    <div className="max-h-[60vh] overflow-auto">
      <table className="w-full text-sm tabular-nums">
        <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
          <tr>
            <th className="py-1.5 pr-2 text-left font-medium">Line item</th>
            {periods.map((p) => (
              <th key={p.date} className="px-2 py-1.5 text-right font-medium">
                {p.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.key} className="border-t border-border/60">
              <td
                className={cn(
                  "py-2 pr-2 text-left",
                  item.emphasis ? "font-medium" : "text-muted-foreground",
                )}
              >
                {item.label}
              </td>
              {periods.map((p) => {
                const v = p.values[item.key] ?? null;
                return (
                  <td
                    key={p.date}
                    className={cn(
                      "px-2 py-2 text-right",
                      item.emphasis && "font-medium",
                      v !== null && v < 0 && "text-bearish",
                    )}
                  >
                    {formatCell(v, item)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One statement: cadence toggle, two-series bar chart and a See-all dialog. */
function StatementSection({
  symbol,
  kind,
  enabled,
}: {
  symbol: string;
  kind: StatementKind;
  enabled: boolean;
}) {
  const [frequency, setFrequency] =
    React.useState<StatementFrequency>("annual");
  const { data, isLoading, isError, refetch } = useFinancials(
    symbol,
    frequency,
    enabled,
  );

  const periods: StatementPeriod[] = data?.[kind] ?? [];
  const series = CHART_SERIES[kind];
  const chartData = periods.map((p) => ({
    label: p.label,
    [series.aKey]: p.values[series.aKey],
    [series.bKey]: p.values[series.bKey],
  }));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{SECTION_TITLES[kind]}</h3>
        <div className="flex items-center gap-2">
          <FrequencyToggle value={frequency} onChange={setFrequency} />
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" disabled={periods.length === 0}>
                See all
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {SECTION_TITLES[kind]} · {symbol}
                </DialogTitle>
              </DialogHeader>
              <StatementTable kind={kind} periods={periods} />
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-36 w-full" />
      ) : isError ? (
        <ErrorState
          title={`Couldn't load the ${SECTION_TITLES[kind].toLowerCase()}`}
          message="The statement data failed to load."
          onRetry={() => void refetch()}
        />
      ) : periods.length > 0 ? (
        <div className="h-36 w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
              <XAxis
                dataKey="label"
                fontSize={10}
                stroke="var(--muted-foreground)"
                tickLine={false}
              />
              <YAxis
                fontSize={10}
                stroke="var(--muted-foreground)"
                tickLine={false}
                width={48}
                tickFormatter={(v: number) => formatLargeCurrency(v)}
              />
              <RTooltip
                formatter={(v) =>
                  typeof v === "number" ? formatLargeCurrency(v) : "—"
                }
                contentStyle={{
                  background: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <ReferenceLine y={0} stroke="var(--border)" />
              <Bar
                dataKey={series.aKey}
                name={series.aLabel}
                fill="var(--primary)"
                radius={[2, 2, 0, 0]}
              />
              <Bar
                dataKey={series.bKey}
                name={series.bLabel}
                fill="var(--bullish)"
                radius={[2, 2, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No statement data available.
        </p>
      )}
    </div>
  );
}

/** Financial statements panel: income, balance sheet and cash flow charts. */
export function FinancialsPanel({ symbol, enabled }: FinancialsPanelProps) {
  return (
    <Card data-testid="financials-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="size-4 text-primary" aria-hidden />
          Financial Statements
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <StatementSection symbol={symbol} kind="income" enabled={enabled} />
        <Separator />
        <StatementSection symbol={symbol} kind="balance" enabled={enabled} />
        <Separator />
        <StatementSection symbol={symbol} kind="cashflow" enabled={enabled} />
      </CardContent>
    </Card>
  );
}
