"use client";

import type { HedgeOverview } from "@/app/api/hedge/overview/route";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

type Ticker = HedgeOverview["tickers"][number];

interface Props {
  overview: HedgeOverview;
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "bullish" | "bearish" | "neutral";
}) {
  const color =
    tone === "bullish"
      ? "text-bullish"
      : tone === "bearish"
        ? "text-bearish"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span className={`text-lg font-semibold tabular-nums ${color}`}>
        {value}
      </span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

/** Market context: index vol, the term slope, correlation regime and the proxy state. */
export function HedgeContextBar({ overview }: Props) {
  const by = (t: string): Ticker | undefined =>
    overview.tickers.find((x) => x.ticker === t);

  const spy = by("SPY");
  const tlt = by("TLT");

  // A bond ETF whose correlation to equities has flipped positive has stopped
  // diversifying — exactly when you needed it to.
  const corr = tlt?.corrSpy60d ?? null;
  const corrFlipped = corr !== null && corr > 0.3;

  const vrpTone = (v: number | null): "bullish" | "bearish" | "neutral" =>
    v === null ? "neutral" : v > 1 ? "bearish" : v < -1 ? "bullish" : "neutral";

  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-6 pt-6">
        <Stat
          label="SPY 30d IV"
          value={
            spy?.atmIv30 !== null && spy ? `${spy.atmIv30?.toFixed(1)}%` : "—"
          }
          sub={
            spy?.ewmaVol != null
              ? `EWMA realized ${spy.ewmaVol.toFixed(1)}%`
              : undefined
          }
        />
        <Stat
          label="SPY VRP"
          value={spy?.vrp != null ? spy.vrp.toFixed(2) : "—"}
          sub={
            spy?.vrp == null
              ? undefined
              : spy.vrp > 0
                ? "options rich vs realized"
                : "protection cheap vs realized"
          }
          tone={vrpTone(spy?.vrp ?? null)}
        />
        <Stat
          label="SPY term slope"
          value={spy?.termSlope != null ? `${spy.termSlope.toFixed(2)}` : "—"}
          sub={spy?.termInverted ? "INVERTED — event priced" : "contango"}
          tone={spy?.termInverted ? "bearish" : "neutral"}
        />
        <Stat
          label="SPY put skew"
          value={spy?.putSkew25d != null ? spy.putSkew25d.toFixed(2) : "—"}
          sub="25Δ put IV − ATM IV"
        />
        <Stat
          label="10y (r)"
          value={
            spy?.riskFreeRate != null
              ? `${(spy.riskFreeRate * 100).toFixed(2)}%`
              : "—"
          }
          sub="13-week bill, used in every delta"
        />

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
            SPY–TLT correlation
          </span>
          <Badge variant={corrFlipped ? "bearish" : "bullish"}>
            {corr === null ? "unknown" : corrFlipped ? "FLIPPED" : "normal"}
            {corr !== null && ` (${corr.toFixed(2)})`}
          </Badge>
          {corrFlipped && (
            <span className="text-[11px] text-bearish">
              Bonds no longer diversifying
            </span>
          )}
        </div>

        {/* The honesty banner. On day one every IV rank is a realized-vol rank. */}
        {overview.ivRank.proxied && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
              IV rank status
            </span>
            <Badge variant="neutral">
              PROXIED · {overview.ivRank.realDays}/
              {overview.ivRank.requiredDays} days
            </Badge>
            <span className="max-w-[16rem] text-[11px] text-muted-foreground">
              IV rank is computed from realized volatility until enough true IV
              history accumulates. VRP needs no history and is honest today.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
