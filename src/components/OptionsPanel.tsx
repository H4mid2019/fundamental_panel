"use client";

import { CandlestickChart } from "lucide-react";
import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ErrorState } from "@/components/ErrorState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useOptions } from "@/hooks/useOptions";

interface OptionsPanelProps {
  symbol: string;
  enabled: boolean;
}

const fmt = (n: number | null, dp = 2) =>
  n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: dp });
const pct = (iv: number | null) =>
  iv === null ? "—" : `${(iv * 100).toFixed(1)}%`;

/** Options chain panel: expiration picker, put/call ratio, IV smile and table. */
export function OptionsPanel({ symbol, enabled }: OptionsPanelProps) {
  // The parent remounts this panel via `key={symbol}`, so expiration state
  // resets naturally when the asset changes.
  const [expiration, setExpiration] = React.useState<string | undefined>(
    undefined,
  );

  const { data, isLoading, isError, refetch } = useOptions(
    symbol,
    enabled,
    expiration,
  );

  const smile = React.useMemo(() => {
    if (!data) return [];
    const putByStrike = new Map(data.puts.map((p) => [p.strike, p]));
    return data.calls.map((c) => {
      const p = putByStrike.get(c.strike);
      return {
        strike: c.strike,
        call: c.impliedVolatility !== null ? c.impliedVolatility * 100 : null,
        put:
          p && p.impliedVolatility !== null ? p.impliedVolatility * 100 : null,
      };
    });
  }, [data]);

  const rows = React.useMemo(() => {
    if (!data) return [];
    const putByStrike = new Map(data.puts.map((p) => [p.strike, p]));
    return data.calls.map((c) => ({ call: c, put: putByStrike.get(c.strike) }));
  }, [data]);

  return (
    <Card data-testid="options-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <CandlestickChart className="size-4 text-primary" aria-hidden />
          Options
        </CardTitle>
        <div className="flex items-center gap-2">
          {data?.putCallRatio !== null && data?.putCallRatio !== undefined ? (
            <Badge
              variant={
                data.putCallRatio > 1
                  ? "bearish"
                  : data.putCallRatio < 0.7
                    ? "bullish"
                    : "neutral"
              }
            >
              P/C {data.putCallRatio.toFixed(2)}
            </Badge>
          ) : null}
          {data && data.expirations.length > 0 ? (
            <select
              aria-label="Expiration"
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={data.expiration}
              onChange={(e) => setExpiration(e.target.value)}
            >
              {data.expirations.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : isError ? (
          <ErrorState
            title="Couldn't load options"
            message="The options chain failed to load."
            onRetry={() => void refetch()}
          />
        ) : data && rows.length > 0 ? (
          <div className="flex flex-col gap-4">
            <div className="h-44 w-full min-w-0">
              <p className="mb-1 text-xs text-muted-foreground">
                Implied volatility smile
              </p>
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart
                  data={smile}
                  margin={{ top: 4, right: 8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis
                    dataKey="strike"
                    fontSize={10}
                    stroke="var(--muted-foreground)"
                    tickLine={false}
                  />
                  <YAxis
                    fontSize={10}
                    stroke="var(--muted-foreground)"
                    tickLine={false}
                    width={32}
                    unit="%"
                  />
                  <RTooltip
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="call"
                    name="Call IV"
                    stroke="var(--bullish)"
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="put"
                    name="Put IV"
                    stroke="var(--bearish)"
                    dot={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="max-h-64 overflow-auto">
              <table className="w-full text-right text-xs tabular-nums">
                <thead className="sticky top-0 bg-card text-muted-foreground">
                  <tr>
                    <th className="px-1 py-1 text-right font-medium">Call</th>
                    <th className="px-1 py-1 text-right font-medium">IV</th>
                    <th className="px-1 py-1 text-center font-medium">
                      Strike
                    </th>
                    <th className="px-1 py-1 text-left font-medium">IV</th>
                    <th className="px-1 py-1 text-left font-medium">Put</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ call, put }) => {
                    const atm =
                      data.underlyingPrice !== null &&
                      Math.abs(call.strike - data.underlyingPrice) ===
                        Math.min(
                          ...rows.map((r) =>
                            Math.abs(
                              r.call.strike - (data.underlyingPrice ?? 0),
                            ),
                          ),
                        );
                    return (
                      <tr
                        key={call.strike}
                        className={atm ? "bg-accent/50 font-medium" : ""}
                      >
                        <td className="px-1 py-0.5 text-bullish">
                          {fmt(call.lastPrice)}
                        </td>
                        <td className="px-1 py-0.5 text-muted-foreground">
                          {pct(call.impliedVolatility)}
                        </td>
                        <td className="px-1 py-0.5 text-center font-medium">
                          {fmt(call.strike)}
                        </td>
                        <td className="px-1 py-0.5 text-left text-muted-foreground">
                          {pct(put?.impliedVolatility ?? null)}
                        </td>
                        <td className="px-1 py-0.5 text-left text-bearish">
                          {fmt(put?.lastPrice ?? null)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {data.fallback ? (
              <p className="text-xs text-muted-foreground">
                Showing sample options (live via Yahoo when reachable).
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No options available.</p>
        )}
      </CardContent>
    </Card>
  );
}
