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

/**
 * Inputs describing the discounting.
 *
 * Note what is **not** here: spot, and the dividend yield. Both are replaced by
 * the implied forward — see {@link impliedForward}.
 */
export interface ParityContext {
  /** The forward price, implied from the chain itself. */
  forward: number;
  /** Time to expiry in years. */
  t: number;
  /** Risk-free rate (continuous). */
  r: number;
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

/** The forward implied from one strike, and how much to trust it. */
export interface ImpliedForward {
  /** F = K + e^{rT} (C - P). */
  forward: number;
  /** The strike it was implied from — the most at-the-money one available. */
  strike: number;
  /**
   * The dividend yield the forward implies: q = r - ln(F/S)/T.
   *
   * This is what the *option market* thinks the carry is, which beats any quoted
   * dividend field: it is the number the market is actually trading against, and
   * it silently includes borrow costs and hard-to-borrow rates that no dividend
   * field knows about.
   */
  impliedQ: number;
  /** Combined half-spread of the pair it came from — the forward's own error bar. */
  uncertainty: number;
}

/**
 * Imply the forward price from the chain itself, using put-call parity.
 *
 * Rearranging `C - P = e^{-rT}(F - K)` gives `F = K + e^{rT}(C - P)`, which needs
 * **no spot price and no dividend yield**. That is the entire point, and it fixes
 * two distinct problems at once:
 *
 *  1. **Spot staleness.** The quote and the chain are captured milliseconds to
 *     seconds apart, and on a fast tape the underlying moves in between. Testing
 *     parity against a spot from a different instant charges every strike on the
 *     board for that timing skew, so a perfectly healthy chain reports a wall of
 *     "violations" that are really just clock drift. (Measured live: 14-31% of
 *     contracts rejected — far too many to be genuine staleness.)
 *
 *  2. **A wrong dividend yield.** Parity is `q`-sensitive, so a bad `q` produced
 *     the same wall of false violations. Yahoo's dividend fields disagree with
 *     each other, which is precisely how much you can trust them.
 *
 * Spot is still passed in, but only to *locate* the at-the-money region — never to
 * compute the forward's value. That division of labour is deliberate: locating the
 * region is coarse and utterly tolerant of a stale spot, while the value comes from
 * the quotes and is therefore immune to it. The estimate is the **median** forward
 * across the near-the-money strikes, so one stale leg cannot move it.
 *
 * Every other strike is then tested against that forward, which makes the check a
 * pure staleness test: it asks only "is this pair consistent with the rest of its
 * own chain?" — exactly the question worth asking, and nothing else.
 *
 * @param quotes - Every call/put pair at this expiry.
 * @param r - Risk-free rate.
 * @param t - Time to expiry in years.
 * @param spot - Used only to window the at-the-money region.
 * @returns The implied forward, or `null` when no near-the-money strike has a
 *   genuine two-sided market on both legs.
 */
export function impliedForward(
  quotes: readonly ParityQuote[],
  r: number,
  t: number,
  spot: number,
): ImpliedForward | null {
  if (spot <= 0) return null;

  // Spot is used ONLY to locate the at-the-money region, never to compute the
  // forward's value. That division of labour is the point: locating the region
  // is coarse and completely tolerant of a stale spot (a 1% move does not change
  // which strikes are near the money), while the forward's precise value comes
  // from the quotes and is therefore immune to that staleness.
  //
  // The tempting alternative — pick the strike with the smallest |C - P|, which
  // is ATM by definition and needs no spot at all — is wrong on a real chain, and
  // wrong in a way that destroys everything downstream. A DEAD strike, where both
  // legs are quoted a penny, also has |C - P| ~ 0. Pick it and the forward becomes
  // that random deep strike, every other strike then "violates" parity against
  // the nonsense, and the entire chain is condemned. (Observed live: an implied
  // dividend yield of 765% on QQQ, and 701 of 1278 SPY contracts rejected.)
  const NEAR = 0.15;

  const candidates: { forward: number; strike: number; uncertainty: number }[] =
    [];

  for (const q of quotes) {
    if (Math.abs(Math.log(q.strike / spot)) > NEAR) continue;

    // Both legs need a genuine two-sided market. A zero bid means nobody is
    // buying it at any price, and its mid is fiction.
    if (q.callBid === null || q.putBid === null) continue;
    if (q.callBid <= 0 || q.putBid <= 0) continue;

    const callMid = mid(q.callBid, q.callAsk);
    const putMid = mid(q.putBid, q.putAsk);
    const callHalf = halfSpread(q.callBid, q.callAsk);
    const putHalf = halfSpread(q.putBid, q.putAsk);
    if (
      callMid === null ||
      putMid === null ||
      callHalf === null ||
      putHalf === null
    ) {
      continue;
    }

    const forward = q.strike + Math.exp(r * t) * (callMid - putMid);
    if (!Number.isFinite(forward) || forward <= 0) continue;
    // A forward miles away from spot is a broken quote, not a carry signal.
    if (forward < spot * 0.7 || forward > spot * 1.3) continue;

    candidates.push({
      forward,
      strike: q.strike,
      uncertainty: callHalf + putHalf,
    });
  }

  if (candidates.length === 0) return null;

  // The MEDIAN forward across the near-the-money strikes, not a single pick.
  // Every one of them implies the same forward in a healthy chain, so
  // disagreement between them IS the staleness — and a median simply ignores the
  // one stale leg that a single-strike estimate would have swallowed whole.
  const sorted = [...candidates].map((c) => c.forward).sort((a, b) => a - b);
  const midIndex = Math.floor(sorted.length / 2);
  const forward =
    sorted.length % 2 === 1
      ? (sorted[midIndex] ?? 0)
      : ((sorted[midIndex - 1] ?? 0) + (sorted[midIndex] ?? 0)) / 2;

  if (!Number.isFinite(forward) || forward <= 0) return null;

  // The reported strike is the one nearest spot — the genuine at-the-money
  // contract. Reporting whichever candidate happened to land in the middle of
  // the sort would be non-deterministic when several imply the same forward.
  let anchor = candidates[0];
  if (!anchor) return null;
  for (const c of candidates) {
    if (Math.abs(c.strike - spot) < Math.abs(anchor.strike - spot)) anchor = c;
  }

  return {
    forward,
    strike: anchor.strike,
    // Filled in by the caller, which knows spot.
    impliedQ: Number.NaN,
    uncertainty: anchor.uncertainty,
  };
}

/**
 * The dividend yield implied by a forward.
 *
 * @param forward - The implied forward.
 * @param spot - Current underlying price.
 * @param r - Risk-free rate.
 * @param t - Time to expiry in years.
 * @returns `q = r - ln(F/S)/T`, or `null` for degenerate inputs.
 */
export function impliedDividendYield(
  forward: number,
  spot: number,
  r: number,
  t: number,
): number | null {
  if (forward <= 0 || spot <= 0 || t <= 0) return null;
  const q = r - Math.log(forward / spot) / t;
  return Number.isFinite(q) ? q : null;
}

/**
 * Test one call/put pair against the chain's own implied forward.
 *
 *   C - P  =  e^{-rT} (F - K)
 *
 * Because `F` came from the chain (see {@link impliedForward}), this asks only
 * "is this pair consistent with the rest of its own chain?" — which is precisely
 * the staleness question, and nothing else. It cannot be fooled by a spot from a
 * different instant, nor by a wrong dividend yield.
 *
 * The threshold is `max(halfSpreadMult x combined half-spread, tolerance)`, plus
 * the forward's own uncertainty. That last term matters: the forward is itself
 * measured from a quoted pair, so it carries that pair's half-spread as error, and
 * charging every other strike for the ATM pair's spread would be double-counting
 * an error the strike did not commit.
 *
 * @param quote - The call and put quotes at one strike.
 * @param ctx - The implied forward, tenor and rate.
 * @param limits - Tolerance and half-spread multiple.
 * @param forwardUncertainty - Half-spread of the pair the forward was implied from.
 * @returns The violation, the threshold, and whether the pair is usable.
 */
export function checkParity(
  quote: ParityQuote,
  ctx: ParityContext,
  limits: ParityLimits,
  forwardUncertainty = 0,
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

  const discount = Math.exp(-ctx.r * ctx.t);
  const theoretical = discount * (ctx.forward - quote.strike);
  const observed = callMid - putMid;
  const violation = Math.abs(observed - theoretical);

  const threshold =
    Math.max(limits.halfSpreadMult * (callHalf + putHalf), limits.tolerance) +
    limits.halfSpreadMult * discount * forwardUncertainty;

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
  /**
   * Contracts that were informative and still failed parity — a stale leg on a
   * quote worth having. A subset of `contractsExcluded`, and the honest measure
   * of how stale a chain is.
   *
   * A parity failure on a contract that carried no signal anyway is counted as
   * illiquid instead. It is still excluded from every metric; it just does not
   * condemn the chain, for the same reason a dead tail does not.
   */
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
