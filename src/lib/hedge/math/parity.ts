/**
 * Put-call parity as a data-quality test.
 *
 * For European options on the same strike and expiry, no-arbitrage forces:
 *
 *   C - P  =  S * e^(-qT) - K * e^(-rT)
 *
 * This is not a model — it needs no volatility, no distribution, no assumption
 * about how the underlying moves. It is enforced by arbitrage, so a *live* market
 * satisfies it to within the bid/ask spread. When a quoted pair violates it by
 * much more than the spread can explain, the market is not telling you something
 * interesting about volatility: one of the two legs is **stale**. Yahoo's chains
 * are full of these — a contract that last traded three days ago still shows its
 * last price, and its implied volatility is computed from it.
 *
 * That is exactly the poison this guards against. An IV solved from a stale quote
 * is not noisy-but-unbiased, it is *wrong*, and averaging more of them does not
 * help. Violating rows are excluded from every metric, and the exclusion rate
 * becomes the ticker's data-quality badge — because a ticker whose chain is
 * mostly stale must not be ranked silently alongside one whose chain is clean.
 */

/** One call/put pair at the same strike and expiry. */
export interface ParityQuote {
  strike: number;
  callBid: number | null;
  callAsk: number | null;
  putBid: number | null;
  putAsk: number | null;
}

/** Inputs describing the underlying and the discounting. */
export interface ParityContext {
  /** Spot price. */
  s: number;
  /** Time to expiry in years. */
  t: number;
  /** Risk-free rate (continuous). */
  r: number;
  /** Dividend yield (continuous). */
  q: number;
}

/** Thresholds that decide when a violation is real. */
export interface ParityLimits {
  /** Absolute floor in currency units. */
  tolerance: number;
  /** A violation is tolerated up to this multiple of the combined half-spread. */
  halfSpreadMult: number;
}

/** The result of testing one strike. */
export interface ParityCheck {
  strike: number;
  /** |observed (C - P) - theoretical|, in currency units. */
  violation: number;
  /** The threshold this violation was judged against. */
  threshold: number;
  /** True when the pair is usable. */
  ok: boolean;
  /** Why it was rejected, when it was. */
  reason: "ok" | "missing_quote" | "parity_violation";
}

const mid = (bid: number | null, ask: number | null): number | null =>
  bid === null || ask === null || ask < bid ? null : (bid + ask) / 2;

const halfSpread = (bid: number | null, ask: number | null): number | null =>
  bid === null || ask === null || ask < bid ? null : (ask - bid) / 2;

/**
 * Test one call/put pair against put-call parity.
 *
 * The threshold is `max(halfSpreadMult x combined half-spread, tolerance)`. The
 * spread term is the honest part: a wide market genuinely cannot pin `C - P` down
 * tightly, so it earns more latitude. The absolute `tolerance` is the floor that
 * stops a quoted zero-width market — which does occur, and is a lie — from being
 * held to a zero threshold and rejected outright.
 *
 * @param quote - The call and put quotes at one strike.
 * @param ctx - Spot, tenor, rate and dividend yield.
 * @param limits - Tolerance and half-spread multiple.
 * @returns The violation, the threshold, and whether the pair is usable.
 */
export function checkParity(
  quote: ParityQuote,
  ctx: ParityContext,
  limits: ParityLimits,
): ParityCheck {
  const callMid = mid(quote.callBid, quote.callAsk);
  const putMid = mid(quote.putBid, quote.putAsk);
  const callHalf = halfSpread(quote.callBid, quote.callAsk);
  const putHalf = halfSpread(quote.putBid, quote.putAsk);

  if (
    callMid === null ||
    putMid === null ||
    callHalf === null ||
    putHalf === null
  ) {
    return {
      strike: quote.strike,
      violation: Number.NaN,
      threshold: Number.NaN,
      ok: false,
      reason: "missing_quote",
    };
  }

  const theoretical =
    ctx.s * Math.exp(-ctx.q * ctx.t) - quote.strike * Math.exp(-ctx.r * ctx.t);
  const observed = callMid - putMid;
  const violation = Math.abs(observed - theoretical);

  const threshold = Math.max(
    limits.halfSpreadMult * (callHalf + putHalf),
    limits.tolerance,
  );

  const ok = violation <= threshold;
  return {
    strike: quote.strike,
    violation,
    threshold,
    ok,
    reason: ok ? "ok" : "parity_violation",
  };
}

/** How trustworthy a ticker's chain is this scan. */
export type DataQuality = "good" | "degraded" | "poor";

/**
 * Per-ticker quote-quality summary, surfaced as a badge in the UI.
 *
 * The distinction between `contractsExcluded` and `contractsIlliquid` is the
 * whole point of this report. A deep out-of-the-money wing quoted 0.00 / 0.02 is
 * *uninformative* — no volatility can be recovered from a one-cent market — but
 * it is not **bad data**, and a ticker should not be badged `poor` for having
 * tails. Only genuine defects (a parity violation, a crossed or missing quote, an
 * absurd implied vol) count against the grade, because the badge exists to answer
 * one question: is this chain stale?
 */
export interface DataQualityReport {
  /** Out-of-the-money contracts considered. ITM contracts are never candidates. */
  contractsTotal: number;
  /** Contracts dropped as **bad data** — this is what the grade is computed on. */
  contractsExcluded: number;
  /** Contracts dropped as uninformative or illiquid. Not a quality failure. */
  contractsIlliquid: number;
  parityViolations: number;
  /** Fraction of candidates free of *defects*, in [0, 1]. */
  goodFraction: number;
  quality: DataQuality;
}

/**
 * Grade a ticker's chain from its exclusion counts.
 *
 * @param total - Out-of-the-money contracts considered.
 * @param excluded - Contracts dropped as bad data (parity, crossed quote, absurd IV).
 * @param parityViolations - How many of those were parity failures specifically.
 * @param goodFraction - At or above this defect-free rate, the chain is `good`.
 * @param minGoodFraction - Below this defect-free rate, the chain is `poor`.
 * @param illiquid - Contracts dropped as uninformative/illiquid; reported, not graded.
 * @returns The report, including the badge.
 */
export function gradeDataQuality(
  total: number,
  excluded: number,
  parityViolations: number,
  goodFraction: number,
  minGoodFraction: number,
  illiquid = 0,
): DataQualityReport {
  // No contracts at all is the worst case, not a perfect score. Guard the
  // division before it produces a reassuring NaN or a 1.0 out of nothing.
  const fraction = total <= 0 ? 0 : (total - excluded) / total;

  const quality: DataQuality =
    total <= 0 || fraction < minGoodFraction
      ? "poor"
      : fraction >= goodFraction
        ? "good"
        : "degraded";

  return {
    contractsTotal: total,
    contractsExcluded: excluded,
    contractsIlliquid: illiquid,
    parityViolations,
    goodFraction: fraction,
    quality,
  };
}
