/**
 * Tail-hedge monitor — flag cheap far-OTM put spreads when the market is
 * complacent about a risk that credit has already noticed.
 *
 * Unlike the other four, this is not a per-ticker screen. It is a **regime**
 * detector, and it looks for one specific disagreement:
 *
 *   credit deteriorating  +  equity vol still asleep  =  hedges on sale
 *
 * Credit usually moves first. When high yield is bleeding against Treasuries while
 * SPY's implied vol sits at the bottom of its range and the VIX curve is in placid
 * contango, the equity market is not yet paying for a risk the bond market is
 * already pricing. That is precisely when convexity is cheap — and precisely when
 * nobody wants it.
 *
 * The composite (each term z-like, in comparable units):
 *
 *   1. VIX term slope   — steep contango = complacency = higher score
 *   2. Credit divergence — HYG weak vs LQD/TLT = stress = higher score
 *   3. SPY put skew      — a FLAT skew means tails are underpriced = higher score
 *
 * Note the sign on skew: a steep skew means the tail is already expensive and
 * there is nothing on sale. It is the *absence* of fear in the wing, alongside
 * stress in credit, that constitutes the signal.
 */

import type { DataQuality } from "../math/parity";

import {
  annualize,
  hashSignal,
  pickByMoneyness,
  pickExpiry,
  round,
  toLeg,
  type ScanContext,
  type Setup,
} from "./types";

/** Market-wide context the composite is built from. */
export interface TailHedgeContext {
  /** VIX term structure levels, ascending in maturity (^VIX9D, ^VIX, ^VIX3M, ^VIX6M). */
  vixTerm: { symbol: string; value: number }[];
  /** Trailing return of HYG minus LQD, in percent — the credit divergence. */
  creditDivergencePct: number | null;
  /** SPY's 25-delta put skew, in vol points. */
  spyPutSkew: number | null;
  /** SPY's IV rank, if known. */
  spyIvRank: number | null;
}

/** The composite reading, surfaced on the dashboard whether or not it fires. */
export interface TailHedgeSignal {
  composite: number;
  vixSlope: number | null;
  creditDivergence: number | null;
  spyPutSkew: number | null;
  /** True when the composite cleared `minCompositeScore`. */
  firing: boolean;
  narrative: string;
}

/**
 * Compute the tail-hedge composite from market context.
 *
 * @param ctx - VIX term, credit divergence, SPY skew.
 * @param minCompositeScore - Threshold above which the monitor fires.
 * @returns The composite and its components.
 */
export function computeTailHedgeSignal(
  ctx: TailHedgeContext,
  minCompositeScore: number,
): TailHedgeSignal {
  const sorted = [...ctx.vixTerm].filter((v) => Number.isFinite(v.value));
  const front = sorted[0]?.value ?? null;
  const back = sorted[sorted.length - 1]?.value ?? null;

  // Contango (back above front) = the market expects calm = complacency.
  // Backwardation = fear is already here, and hedges are no longer cheap.
  const vixSlope =
    front !== null && back !== null && front > 0
      ? ((back - front) / front) * 100
      : null;

  const parts: number[] = [];
  const reasons: string[] = [];

  if (vixSlope !== null) {
    // A 30%+ contango is deeply complacent; normalize so that maps to ~1.
    const term = vixSlope / 30;
    parts.push(term);
    if (term > 0.8)
      reasons.push(`VIX curve in steep contango (${vixSlope.toFixed(0)}%)`);
  }

  if (ctx.creditDivergencePct !== null) {
    // Negative divergence (HYG underperforming) is stress. Flip the sign so
    // stress raises the score.
    const term = -ctx.creditDivergencePct / 2;
    parts.push(term);
    if (term > 0.5) {
      reasons.push(
        `Credit deteriorating (HYG ${ctx.creditDivergencePct.toFixed(1)}% vs LQD)`,
      );
    }
  }

  if (ctx.spyPutSkew !== null) {
    // A FLAT skew means the tail is cheap. A steep one means it is already bid.
    const term = (3 - ctx.spyPutSkew) / 2;
    parts.push(term);
    if (term > 0.5) {
      reasons.push(
        `SPY put skew is flat (${ctx.spyPutSkew.toFixed(1)} vol pts) — tails underpriced`,
      );
    }
  }

  const composite = parts.reduce((a, b) => a + b, 0);
  const firing = parts.length > 0 && composite >= minCompositeScore;

  const narrative = firing
    ? `Tail hedge signal: ${reasons.join("; ")}. Credit is pricing a risk equity vol is not.`
    : parts.length === 0
      ? "Insufficient market context to compute the tail-hedge composite."
      : `No tail-hedge signal (composite ${composite.toFixed(2)} < ${minCompositeScore}).`;

  return {
    composite,
    vixSlope,
    creditDivergence: ctx.creditDivergencePct,
    spyPutSkew: ctx.spyPutSkew,
    firing,
    narrative,
  };
}

/**
 * Build the concrete far-OTM put spread the monitor recommends when it fires.
 *
 * @param scan - The underlying (SPY or ^SPX) to hedge with.
 * @param signal - The composite reading.
 * @returns The setup, or `null` when the monitor is not firing or has no strikes.
 */
export function buildTailHedgeSetup(
  scan: ScanContext,
  signal: TailHedgeSignal,
): Setup | null {
  const { metrics: m, surface, config } = scan;
  const cfg = config.scanners.tailHedge;
  if (!cfg.enabled || !signal.firing) return null;

  const expiry = pickExpiry(surface.expiries, cfg.dteRange[0], cfg.dteRange[1]);
  if (!expiry) return null;

  const spot = surface.spot;
  const longPut = pickByMoneyness(expiry.puts, spot, -cfg.otmPctRange[0]);
  const shortPut = pickByMoneyness(expiry.puts, spot, -cfg.otmPctRange[1]);
  if (!longPut || !shortPut || longPut.strike <= shortPut.strike) return null;

  const netDebit = longPut.mid - shortPut.mid;
  if (netDebit <= 0) return null;

  const width = longPut.strike - shortPut.strike;
  const maxPayoff = width - netDebit;
  const payoffRatio = maxPayoff / netDebit;
  const costPct = (netDebit / spot) * 100;

  const warnings: string[] = [];
  if (m.dataQuality !== "good")
    warnings.push(`Chain data quality is ${m.dataQuality}`);
  if (m.ratesFallback)
    warnings.push("Deltas used a fallback rate or dividend yield");

  const quality: DataQuality = m.dataQuality;

  return {
    scanner: "tailHedge",
    ticker: m.ticker,
    score: signal.composite,
    legs: [toLeg("buy", longPut, expiry), toLeg("sell", shortPut, expiry)],
    stats: {
      composite: round(signal.composite),
      vixSlope: round(signal.vixSlope, 1),
      creditDivergence: round(signal.creditDivergence, 2),
      spyPutSkew: round(signal.spyPutSkew, 2),
      netDebit: round(netDebit),
      costPct: round(costPct),
      maxPayoff: round(maxPayoff),
      payoffRatio: round(payoffRatio),
      annualizedCost: round(annualize(costPct, expiry.dte)),
      dte: expiry.dte,
    },
    summary:
      `Buy ${expiry.expiration} ${longPut.strike}P / sell ${shortPut.strike}P for ` +
      `${netDebit.toFixed(2)} (${costPct.toFixed(2)}% of notional). Pays ` +
      `${payoffRatio.toFixed(0)}:1 on a tail move. ${signal.narrative}`,
    warnings,
    proxied: m.ivRankProxied,
    ratesFallback: m.ratesFallback,
    dataQuality: quality,
    signalHash: hashSignal("tailHedge", m.ticker, [
      expiry.expiration,
      longPut.strike,
      shortPut.strike,
      round(signal.composite, 1),
    ]),
  };
}
