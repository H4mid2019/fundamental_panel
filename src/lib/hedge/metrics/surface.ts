/**
 * Turn a raw chain snapshot into a clean volatility surface.
 *
 * This is where every correctness rule converges, so the order of operations
 * matters:
 *
 *  1. **Parity first.** Stale quotes are removed by put-call parity *before*
 *     anything is solved from them, because an IV solved from a stale price is
 *     not noisy-but-unbiased, it is wrong, and no amount of averaging fixes it.
 *  2. **Solve IV from the mid, never trust the feed's.** Yahoo's
 *     `impliedVolatility` is derived from `lastPrice`, which can be days old.
 *  3. **Out-of-the-money wings, plus a band around the forward.** IV is not
 *     identifiable from a *deep* in-the-money contract — its premium is all
 *     intrinsic and vega collapses — but that is emphatically not true near the
 *     money, where vega is at its largest on either side of the forward. A
 *     blanket "OTM only" rule discards precisely the strikes adjacent to the
 *     forward, and on a thin ETF chain leaves nothing to bracket the ATM point
 *     with, so ATM IV (and therefore VRP) returns null on the names that matter
 *     most. Deep-ITM contracts fall out on their own: the IV solver declines
 *     them once vega collapses.
 *  4. **Delta with r and q.** On TLT, HYG, LQD and XLU the dividend yield moves
 *     delta by whole percent, and 25-delta strike selection is defined in terms
 *     of it.
 */

import { logger } from "../../logger";
import type { HedgeConfig } from "../config";
import { delta, impliedVolatility, yearsToExpiry } from "../math/blackScholes";
import { ivAtDelta, pchip } from "../math/interpolation";
import {
  checkParity,
  gradeDataQuality,
  impliedDividendYield,
  impliedForward,
  type DataQualityReport,
} from "../math/parity";
import type { ChainSnapshot, HedgeContract, OptionRight } from "../types";

/** The rate environment a surface was built in. */
export interface RateContext {
  /** Continuously-compounded risk-free rate. */
  r: number;
  /** Continuous dividend yield. */
  q: number;
  /**
   * True when either `r` or `q` was unavailable and a fallback was substituted.
   * Every metric derived from this surface is flagged, because a delta computed
   * from a guessed rate is approximate and must not be presented as exact.
   */
  fallback: boolean;
}

/** One usable contract on the surface. */
export interface SurfacePoint {
  strike: number;
  right: OptionRight;
  /** Implied volatility solved from the bid/ask midpoint. */
  iv: number;
  /** |delta|, computed with the real r and q. */
  absDelta: number;
  mid: number;
  openInterest: number | null;
  /** Bid/ask spread as a fraction of the mid. */
  relSpread: number;
}

/** The cleaned surface for one expiry. */
export interface ExpirySurface {
  expiration: string;
  dte: number;
  /** Time to expiry in years. */
  t: number;
  standardMonthly: boolean;
  usableForSkew: boolean;
  /** At-the-money-forward IV, or `null` when the strikes do not bracket it. */
  atmIv: number | null;
  /** The forward implied from this expiry's own chain (see `math/parity`). */
  forward: number;
  /** The dividend yield the option market is trading against, if it could be implied. */
  impliedQ: number | null;
  /** Out-of-the-money calls (strike above spot), ascending by strike. */
  calls: SurfacePoint[];
  /** Out-of-the-money puts (strike below spot), ascending by strike. */
  puts: SurfacePoint[];
  /** Out-of-the-money contracts considered. */
  contractsTotal: number;
  /** Dropped as bad data (parity, crossed quote, absurd IV). Drives the badge. */
  contractsExcluded: number;
  /** Dropped as uninformative or too wide to price. Not a quality failure. */
  contractsIlliquid: number;
  /**
   * Contracts that were **informative** and still failed parity — a stale leg on
   * a quote worth having. A subset of `contractsExcluded`.
   *
   * A parity failure on a contract that carried no signal anyway (a penny wing)
   * is counted in `contractsIlliquid` instead: it is still excluded from every
   * metric, but a chain is not stale merely because its tails are dead.
   */
  parityViolations: number;
}

/** A ticker's full cleaned surface. */
export interface Surface {
  ticker: string;
  spot: number;
  rates: RateContext;
  expiries: ExpirySurface[];
  quality: DataQualityReport;
}

/**
 * How far either side of the forward a contract may sit and still be used for
 * the at-the-money read, in absolute log-moneyness.
 *
 * 10% is comfortably inside the region where vega is large on both sides, so the
 * IV solved from an in-the-money contract here is every bit as reliable as its
 * out-of-the-money twin — and put-call parity has already checked they agree.
 */
const NEAR_FORWARD_BAND = 0.1;

/** Midpoint of a two-sided quote, or `null`. */
function midOf(c: HedgeContract): number | null {
  if (c.bid === null || c.ask === null) return null;
  if (c.ask < c.bid) return null; // crossed market
  const m = (c.bid + c.ask) / 2;
  return m > 0 ? m : null;
}

/**
 * Build the cleaned surface for one expiry.
 *
 * @returns The surface, and the counts feeding the data-quality badge.
 */
function buildExpiry(
  expiry: ChainSnapshot["expiries"][number],
  spot: number,
  rates: RateContext,
  config: HedgeConfig,
): ExpirySurface {
  const t = yearsToExpiry(expiry.dte);
  const { quality } = config.chain;
  const parityLimits = config.metrics.parity;

  const all = [...expiry.calls, ...expiry.puts];

  // ── 1. Imply the forward FROM THE CHAIN, then test parity against it. ──
  //
  // The forward is not computed as S*e^{(r-q)T}. It is implied from the most
  // at-the-money quoted pair: F = K + e^{rT}(C - P). That needs no spot and no
  // dividend yield, which is exactly why it is right — testing parity against a
  // spot captured at a different instant, or against a dividend yield Yahoo is
  // unsure of, charges every strike on the board for an error it did not commit.
  const callByStrike = new Map(expiry.calls.map((c) => [c.strike, c]));
  const putByStrike = new Map(expiry.puts.map((p) => [p.strike, p]));
  const strikes = [...new Set([...callByStrike.keys(), ...putByStrike.keys()])];

  const pairs = strikes
    .map((strike) => {
      const call = callByStrike.get(strike);
      const put = putByStrike.get(strike);
      if (!call || !put) return null;
      return {
        strike,
        callBid: call.bid,
        callAsk: call.ask,
        putBid: put.bid,
        putAsk: put.ask,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const implied = impliedForward(pairs, rates.r, t, spot);

  // Fall back to the theoretical forward only when the chain cannot imply one
  // (no strike with a two-sided market on both legs) — a genuinely broken chain.
  const forward = implied?.forward ?? spot * Math.exp((rates.r - rates.q) * t);

  // The dividend yield the *option market* is trading against. It beats any
  // quoted field, because it silently includes borrow cost and hard-to-borrow
  // rates that no dividend field knows about. Sanity-bounded: a nonsense forward
  // on a broken chain must not poison every delta.
  const marketQ =
    implied !== null
      ? impliedDividendYield(implied.forward, spot, rates.r, t)
      : null;
  const q =
    marketQ !== null && marketQ >= -0.05 && marketQ <= 0.3 ? marketQ : rates.q;

  const effectiveRates: RateContext = { ...rates, q };

  const rejected = new Set<number>();

  if (implied !== null) {
    for (const pair of pairs) {
      const check = checkParity(
        pair,
        { forward: implied.forward, t, r: rates.r },
        parityLimits,
        implied.uncertainty,
      );
      if (check.reason === "parity_violation") rejected.add(pair.strike);
    }
  }

  // ── 2-4. Solve IV from the mid on the OTM wing, then delta with r and q. ──
  //
  // Rejections are split into two kinds, and the distinction matters:
  //
  //   defects   — a parity violation, a crossed/missing quote, an absurd IV.
  //               These mean the data is BAD, and they drive the quality badge.
  //   no signal — a one-cent wing whose IV is unrecoverable (vega has collapsed),
  //               or a market too wide to price against. These are normal
  //               features of a real chain, not defects, and a ticker must not be
  //               badged `poor` merely for having tails.
  let defects = 0;
  let noSignal = 0;
  let parityViolations = 0;

  /** What a contract is worth judged on its own quote, parity aside. */
  type Screen =
    | { kind: "usable"; point: SurfacePoint }
    | { kind: "defect" }
    | { kind: "no_signal" };

  /**
   * Grade one contract on its own quote — deliberately blind to parity, so that
   * the caller can ask "was this contract informative at all?" independently of
   * whether parity condemned its strike.
   */
  const screen = (c: HedgeContract): Screen => {
    if (quality.requireTwoSidedQuote && (c.bid === null || c.ask === null)) {
      return { kind: "defect" };
    }

    const mid = midOf(c);
    // A crossed market (ask < bid) is a defect, not merely a thin one.
    if (mid === null) return { kind: "defect" };

    const relSpread =
      c.bid !== null && c.ask !== null ? (c.ask - c.bid) / mid : Infinity;
    if (relSpread > quality.maxRelativeSpread) return { kind: "no_signal" };

    const iv = impliedVolatility(
      mid,
      { s: spot, k: c.strike, t, r: rates.r, q: effectiveRates.q },
      c.right,
    );

    // `null` means no volatility is recoverable from this price at all — the
    // honest answer for a penny wing, and not a data defect.
    if (iv === null) return { kind: "no_signal" };
    // An IV outside the plausible band, however, IS suspicious data.
    if (iv < quality.minIv || iv > quality.maxIv) return { kind: "defect" };

    const absDelta = Math.abs(
      delta(
        { s: spot, k: c.strike, t, r: rates.r, q: effectiveRates.q, sigma: iv },
        c.right,
      ),
    );
    if (!Number.isFinite(absDelta) || absDelta <= 0 || absDelta >= 1) {
      return { kind: "no_signal" };
    }

    return {
      kind: "usable",
      point: {
        strike: c.strike,
        right: c.right,
        iv,
        absDelta,
        mid,
        openInterest: c.openInterest,
        relSpread,
      },
    };
  };

  const usable = (c: HedgeContract): SurfacePoint | null => {
    // Out-of-the-money contracts, plus anything near the forward.
    //
    // The tempting rule is "OTM only", on the grounds that an ITM premium is all
    // intrinsic and carries no volatility information. That is true *deep* ITM
    // and false near the money — a near-the-money option has the HIGHEST vega on
    // the chain whichever side of the forward it sits. Excluding every ITM
    // contract therefore throws away exactly the strikes adjacent to the forward,
    // and on a thin ETF chain (HYG listed 2 usable calls and 0 puts at 68 DTE)
    // there is then nothing left to bracket the ATM point with, so ATM IV — and
    // with it VRP — comes back null on the very names that matter most.
    //
    // Deep-ITM contracts still contribute nothing: `impliedVolatility` returns
    // null once vega collapses, so they drop out below as "no signal" rather than
    // needing a blanket rule here.
    const otm = c.right === "call" ? c.strike > spot : c.strike < spot;
    const nearForward =
      Math.abs(Math.log(c.strike / forward)) <= NEAR_FORWARD_BAND;
    if (!otm && !nearForward) return null;

    const verdict = screen(c);

    // A parity-violating strike is dropped from every metric either way — one of
    // its legs is stale, and an IV solved from a stale quote is wrong rather than
    // merely noisy. What the violation does NOT settle is whether the CHAIN is
    // stale, which is the only question the badge asks.
    //
    // So the contract is screened on its own quote first, and parity counts
    // against the grade only when that screen found it informative. A penny wing
    // that violates parity is still just a penny wing: no volatility was
    // recoverable from it, the spread and vega screens would have dropped it
    // anyway as `no_signal`, and dropping it costs the surface nothing. Booking
    // it as a defect merely because parity happened to test it first applies two
    // different standards to the identical worthless contract — and that, not a
    // tight threshold, is what badged the thin ETFs `degraded` for having tails.
    //
    // Measured live (2026-07-12, ~3,000 pairs): parity rejected 70.8% of
    // contracts more than 20% out of the money but only 2.0% of those within 2%
    // of the forward, so the informative core of every chain was clean while the
    // wings were not. The rejected contracts had a median last trade 101 days old
    // and a median open interest of ZERO, against 4 days and 71 for the accepted
    // ones — they are genuinely dead, not victims of a tight threshold, and the
    // threshold is deliberately NOT touched here. Loosening it to admit them was
    // measured too: it recovers almost nothing (23.1% -> 14.9% of pairs at a 6x
    // looser multiple) and what it readmits is quotes months stale, which is the
    // exact poison the check exists to keep out of the metrics.
    if (rejected.has(c.strike)) {
      if (verdict.kind === "no_signal") {
        noSignal += 1;
      } else {
        parityViolations += 1;
        defects += 1;
      }
      return null;
    }

    if (verdict.kind === "defect") {
      defects += 1;
      return null;
    }
    if (verdict.kind === "no_signal") {
      noSignal += 1;
      return null;
    }
    return verdict.point;
  };

  const calls = expiry.calls
    .map(usable)
    .filter((p): p is SurfacePoint => p !== null)
    .sort((a, b) => a.strike - b.strike);
  const puts = expiry.puts
    .map(usable)
    .filter((p): p is SurfacePoint => p !== null)
    .sort((a, b) => a.strike - b.strike);

  // Candidates = what we were willing to consider. Deep-ITM contracts were never
  // candidates, so a ticker is not marked down for having them.
  const candidates = all.filter((c) => {
    const otm = c.right === "call" ? c.strike > spot : c.strike < spot;
    return otm || Math.abs(Math.log(c.strike / forward)) <= NEAR_FORWARD_BAND;
  }).length;

  // ── ATM-forward IV. ──
  //
  // Near the forward a strike may now yield BOTH a call and a put point. In
  // theory put-call parity makes them identical, and parity has already vetted
  // the pair — but the out-of-the-money leg is the liquid one, so it is preferred
  // and the in-the-money twin is only used where no OTM quote exists at that
  // strike. Feeding both to the spline would put two knots at the same x.
  const byStrike = new Map<number, SurfacePoint>();
  const isOtm = (p: SurfacePoint): boolean =>
    p.right === "call" ? p.strike > spot : p.strike < spot;

  for (const p of [...puts, ...calls]) {
    const existing = byStrike.get(p.strike);
    if (!existing || (isOtm(p) && !isOtm(existing))) byStrike.set(p.strike, p);
  }

  const smile = [...byStrike.values()]
    .map((p) => ({ x: p.strike, y: p.iv }))
    .sort((a, b) => a.x - b.x);
  const atmIv = smile.length >= 2 ? pchip(smile, forward) : null;

  return {
    expiration: expiry.expiration,
    dte: expiry.dte,
    t,
    standardMonthly: expiry.standardMonthly,
    usableForSkew: expiry.usableForSkew,
    atmIv: atmIv !== null && atmIv > 0 ? atmIv : null,
    forward,
    impliedQ: marketQ,
    calls,
    puts,
    contractsTotal: candidates,
    contractsExcluded: defects,
    contractsIlliquid: noSignal,
    parityViolations,
  };
}

/**
 * Build a ticker's cleaned volatility surface from a raw chain snapshot.
 *
 * @param snapshot - The captured chain.
 * @param rates - The rate environment (r, q, and whether either is a fallback).
 * @param config - Quality and parity thresholds.
 * @returns The surface, or `null` when the snapshot has no spot to anchor it.
 */
export function buildSurface(
  snapshot: ChainSnapshot,
  rates: RateContext,
  config: HedgeConfig,
): Surface | null {
  const spot = snapshot.spot;
  if (spot === null || spot <= 0) {
    logger.warn("hedge.surface: no spot; cannot build surface", {
      ticker: snapshot.ticker,
    });
    return null;
  }

  const expiries = snapshot.expiries.map((e) =>
    buildExpiry(e, spot, rates, config),
  );

  let total = 0;
  let excluded = 0;
  let illiquid = 0;
  let violations = 0;
  for (const e of expiries) {
    total += e.contractsTotal;
    excluded += e.contractsExcluded;
    illiquid += e.contractsIlliquid;
    violations += e.parityViolations;
  }

  const quality = gradeDataQuality(
    total,
    excluded,
    violations,
    config.metrics.parity.goodFraction,
    config.metrics.parity.minGoodFraction,
    illiquid,
  );

  if (quality.quality === "poor") {
    logger.warn("hedge.surface: chain is mostly unusable", {
      ticker: snapshot.ticker,
      total,
      excluded,
      parityViolations: violations,
    });
  }

  return {
    ticker: snapshot.ticker,
    spot,
    rates,
    expiries: expiries.sort((a, b) => a.dte - b.dte),
    quality,
  };
}

/** The 25-delta skew readings for one expiry, all in **vol points** (percent). */
export interface SkewReading {
  expiration: string;
  dte: number;
  /** 25-delta put IV minus ATM IV. Positive = puts bid over the money. */
  putSkew: number | null;
  /** 25-delta call IV minus 25-delta put IV. Positive = calls rich (collar-friendly). */
  callPutSpread: number | null;
  /** Strike a scanner would actually trade for the 25-delta put. */
  put25Strike: number | null;
  /** Strike a scanner would actually trade for the 25-delta call. */
  call25Strike: number | null;
  /** True when both wings genuinely bracketed 25 delta. */
  bracketed: boolean;
}

/**
 * Read the 25-delta skew off one expiry.
 *
 * Returns nulls, never an extrapolation: a weekly's ladder cannot reach 25 delta,
 * and `usableForSkew` blocks it outright, but even a monthly can come up short on
 * a thin name. In that case the honest answer is that this ticker has no
 * 25-delta reading today.
 *
 * @param expiry - A cleaned expiry surface.
 * @returns The skew reading in vol points.
 */
export function readSkew(expiry: ExpirySurface): SkewReading {
  const empty: SkewReading = {
    expiration: expiry.expiration,
    dte: expiry.dte,
    putSkew: null,
    callPutSpread: null,
    put25Strike: null,
    call25Strike: null,
    bracketed: false,
  };

  // A 25-delta strike simply does not exist on a thin weekly ladder.
  if (!expiry.usableForSkew || expiry.atmIv === null) return empty;

  const put25 = ivAtDelta(expiry.puts, 0.25);
  const call25 = ivAtDelta(expiry.calls, 0.25);

  const toPoints = (a: number, b: number) => (a - b) * 100;

  return {
    expiration: expiry.expiration,
    dte: expiry.dte,
    putSkew: put25 ? toPoints(put25.iv, expiry.atmIv) : null,
    callPutSpread: call25 && put25 ? toPoints(call25.iv, put25.iv) : null,
    put25Strike: put25?.nearestStrike ?? null,
    call25Strike: call25?.nearestStrike ?? null,
    bracketed: put25 !== null && call25 !== null,
  };
}
