/**
 * Shared scanner vocabulary: what a setup is, how strikes get picked, and the
 * frictions that make a theoretically-good setup untradeable in practice.
 *
 * Every scanner outputs concrete, tradeable legs — a strike and an expiry you
 * could actually send to a broker — not an abstract score. A ranked list of
 * scores with no strikes attached is a screener that has done half the job.
 */

import type { HedgeConfig } from "../config";
import type { DataQuality } from "../math/parity";
import type { TickerMetrics } from "../metrics/engine";
import type { ExpirySurface, Surface, SurfacePoint } from "../metrics/surface";
import type { DividendProfile } from "../providers/underlying";
import type { OptionRight } from "../types";

/** The scanners, by stable id. */
export const SCANNER_IDS = [
  "protectivePut",
  "putDebitSpread",
  "callCredit",
  "collar",
  "tailHedge",
] as const;

/** One of the five scanners. */
export type ScannerId = (typeof SCANNER_IDS)[number];

/** Human labels for the strategy tabs. */
export const SCANNER_LABELS: Record<ScannerId, string> = {
  protectivePut: "Protective puts",
  putDebitSpread: "Put debit spreads",
  callCredit: "Call credit / covered calls",
  collar: "Collars",
  tailHedge: "Tail hedges",
};

/** One tradeable leg of a setup. */
export interface Leg {
  action: "buy" | "sell";
  right: OptionRight;
  strike: number;
  /** `YYYY-MM-DD`. */
  expiration: string;
  dte: number;
  /** Bid/ask midpoint — what you would realistically pay or receive. */
  mid: number;
  iv: number;
  absDelta: number;
  openInterest: number | null;
  relSpread: number;
}

/** A concrete, ranked trade idea. */
export interface Setup {
  scanner: ScannerId;
  ticker: string;
  /** Higher is better. Comparable only within one scanner. */
  score: number;
  legs: Leg[];
  /**
   * Display metrics for the table — cost, yield, floor, cap, and so on. Kept as
   * a bag rather than a union because each scanner reports different economics.
   */
  stats: Record<string, number | null>;
  /** One-line plain-English description of the trade. */
  summary: string;
  /**
   * Everything that makes this setup worse than its score suggests: earnings in
   * the tenor, assignment risk, a wide market, a stale chain. Surfaced in the UI
   * next to the rank, because a top-ranked setup with three warnings is not
   * actually the best trade on the board.
   */
  warnings: string[];
  /** True when any input was a proxied (realized-vol) IV rank. */
  proxied: boolean;
  /** True when the delta used a fallback rate or dividend yield. */
  ratesFallback: boolean;
  dataQuality: DataQuality;
  /** Stable hash of the signal, keying the AI cache. */
  signalHash: string;
}

/** Everything a scanner needs about one ticker. */
export interface ScanContext {
  metrics: TickerMetrics;
  surface: Surface;
  dividends: DividendProfile;
  config: HedgeConfig;
}

/** A scanner: pure, synchronous, one ticker in, at most one setup out. */
export interface Scanner {
  id: ScannerId;
  /** `null` when this ticker does not qualify. Never throws. */
  run(ctx: ScanContext): Setup | null;
}

/* ── strike selection ──────────────────────────────────────────────────────── */

/**
 * The listed strike whose |delta| is closest to `target`, within `[lo, hi]`.
 *
 * Scanners must trade a **real** contract, so unlike the metrics layer — which
 * interpolates to a synthetic exactly-25-delta point for comparability — this
 * returns an actual listed strike. A setup quoting a strike that does not exist
 * is worse than no setup.
 *
 * @param points - Candidate contracts.
 * @param target - Desired |delta|.
 * @param lo - Lowest acceptable |delta|.
 * @param hi - Highest acceptable |delta|.
 * @returns The best contract, or `null` when none falls in the band.
 */
export function pickByDelta(
  points: readonly SurfacePoint[],
  target: number,
  lo: number,
  hi: number,
): SurfacePoint | null {
  let best: SurfacePoint | null = null;
  for (const p of points) {
    if (p.absDelta < lo || p.absDelta > hi) continue;
    if (
      best === null ||
      Math.abs(p.absDelta - target) < Math.abs(best.absDelta - target)
    ) {
      best = p;
    }
  }
  return best;
}

/**
 * The listed strike closest to a given percentage away from spot.
 *
 * @param points - Candidate contracts.
 * @param spot - Underlying price.
 * @param pctFromSpot - Signed percent (e.g. `-7` for 7% below spot).
 * @returns The nearest listed strike, or `null` when there are no candidates.
 */
export function pickByMoneyness(
  points: readonly SurfacePoint[],
  spot: number,
  pctFromSpot: number,
): SurfacePoint | null {
  const target = spot * (1 + pctFromSpot / 100);
  let best: SurfacePoint | null = null;
  for (const p of points) {
    if (
      best === null ||
      Math.abs(p.strike - target) < Math.abs(best.strike - target)
    ) {
      best = p;
    }
  }
  return best;
}

/** The captured expiry whose DTE sits in `[lo, hi]` and is closest to the middle. */
export function pickExpiry(
  expiries: readonly ExpirySurface[],
  lo: number,
  hi: number,
  opts: { requireSkewUsable?: boolean } = {},
): ExpirySurface | null {
  const target = (lo + hi) / 2;
  let best: ExpirySurface | null = null;
  for (const e of expiries) {
    if (e.dte < lo || e.dte > hi) continue;
    if (opts.requireSkewUsable && !e.usableForSkew) continue;
    if (
      best === null ||
      Math.abs(e.dte - target) < Math.abs(best.dte - target)
    ) {
      best = e;
    }
  }
  return best;
}

/** Turn a surface point into a leg. */
export function toLeg(
  action: "buy" | "sell",
  point: SurfacePoint,
  expiry: ExpirySurface,
): Leg {
  return {
    action,
    right: point.right,
    strike: point.strike,
    expiration: expiry.expiration,
    dte: expiry.dte,
    mid: point.mid,
    iv: point.iv,
    absDelta: point.absDelta,
    openInterest: point.openInterest,
    relSpread: point.relSpread,
  };
}

/* ── frictions ─────────────────────────────────────────────────────────────── */

/**
 * B7 — early-assignment risk on a short call.
 *
 * A short call is only *genuinely* at risk of early exercise when the holder gains
 * more by exercising early and capturing the dividend than by holding the option's
 * remaining time value. The textbook condition:
 *
 *   extrinsic = callMid - max(0, S - K)
 *   at risk when: an ex-dividend date falls before expiry
 *             AND extrinsic < dividend x buffer
 *
 * "There is a dividend in the tenor" on its own is not a risk — every quarterly
 * payer has one, and flagging them all would make the penalty meaningless. The
 * extrinsic-value test is what makes it discriminating.
 *
 * @param callMid - Mid price of the short call.
 * @param spot - Underlying price.
 * @param strike - Call strike.
 * @param expiration - Call expiry, `YYYY-MM-DD`.
 * @param dividends - The underlying's dividend profile.
 * @param buffer - Safety multiple; 1.0 is the textbook boundary.
 * @returns Whether the short call is at real risk, and the numbers behind it.
 */
export function earlyAssignmentRisk(
  callMid: number,
  spot: number,
  strike: number,
  expiration: string,
  dividends: DividendProfile,
  buffer: number,
): { atRisk: boolean; extrinsic: number; dividend: number | null } {
  const extrinsic = callMid - Math.max(0, spot - strike);
  const dividend = dividends.nextAmount;
  const exDate = dividends.nextExDate;

  if (dividend === null || exDate === null) {
    return { atRisk: false, extrinsic, dividend };
  }

  const exBeforeExpiry = Date.parse(exDate) <= Date.parse(expiration);
  if (!exBeforeExpiry) return { atRisk: false, extrinsic, dividend };

  return { atRisk: extrinsic < dividend * buffer, extrinsic, dividend };
}

/** Does an earnings date fall inside this tenor? */
export function earningsInTenor(
  earningsDate: string | null,
  expiration: string,
  asOf: string,
): boolean {
  if (earningsDate === null) return false;
  const e = Date.parse(earningsDate);
  return e >= Date.parse(asOf) && e <= Date.parse(expiration);
}

/** Annualize a return over `dte` days. */
export function annualize(returnPct: number, dte: number): number {
  if (dte <= 0) return 0;
  return (returnPct * 365) / dte;
}

/** A deterministic content hash, keying the AI cache. Mirrors `ai/openrouter.ts`. */
export function hashSignal(
  scanner: string,
  ticker: string,
  parts: unknown,
): string {
  const serialized = JSON.stringify([scanner, ticker, parts]);
  let hash = 5381;
  for (let i = 0; i < serialized.length; i += 1) {
    hash = (hash * 33) ^ serialized.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/** Round to `dp` decimal places, preserving `null`. */
export function round(n: number | null, dp = 2): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
