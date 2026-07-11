/**
 * Black-Scholes-Merton pricing, greeks and implied-volatility inversion.
 *
 * This is load-bearing math, not a convenience. Yahoo publishes no greeks, so
 * 25-delta strike selection — which metrics #2 and #3 and the collar and
 * call-credit scanners are all defined in terms of — exists only because of the
 * `delta()` below. And Yahoo's own `impliedVolatility` field is derived from
 * `lastPrice`, which is frequently stale (a live pull showed a 2-DTE near-ATM
 * SPY call quoting 5.5% IV), so `impliedVolatility()` here re-solves IV from the
 * bid/ask midpoint and Yahoo's figure is demoted to a fallback.
 *
 * Conventions throughout: `sigma` and `r`/`q` are decimal fractions per annum
 * (0.25 = 25%), `t` is in years, and every function is pure and total — no
 * exceptions, `null` for "no answer exists".
 */

import type { OptionRight } from "../types";

/** Inputs shared by every pricing function. */
export interface BsInputs {
  /** Spot price of the underlying. */
  s: number;
  /** Strike. */
  k: number;
  /** Time to expiry in years. */
  t: number;
  /** Continuously-compounded risk-free rate (0.042 = 4.2%). */
  r: number;
  /** Continuous dividend yield. */
  q: number;
  /** Volatility (0.25 = 25%). */
  sigma: number;
}

/** Trading sessions per year — matches `indicators/priceAction.ts`. */
export const TRADING_DAYS = 252;

/** Calendar days per year, used to convert DTE to the `t` Black-Scholes wants. */
export const CALENDAR_DAYS = 365;

/**
 * Convert days-to-expiry into Black-Scholes time in years.
 *
 * Calendar days, not trading days: the discount factor `e^{-rt}` accrues over
 * wall-clock time, and market convention quotes option tenors the same way.
 *
 * @param dte - Days to expiry.
 * @returns Time in years, floored just above zero so expiry-day math stays finite.
 */
export function yearsToExpiry(dte: number): number {
  return Math.max(dte, 1) / CALENDAR_DAYS;
}

/**
 * Standard normal probability density.
 *
 * @param x - The point to evaluate at.
 * @returns The density at `x`.
 */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal cumulative distribution — Hart's rational approximation,
 * accurate to roughly double-precision epsilon (~1e-15).
 *
 * The obvious choice here is the Abramowitz & Stegun 26.2.17 polynomial, and it
 * is wrong for this job. Its 7.5e-8 error sounds harmless but is larger than the
 * entire premium of a far-OTM contract, so a tail strike's price becomes mostly
 * approximation noise — and {@link impliedVolatility}, which inverts that price,
 * then returns confident nonsense (a round-trip test recovered 0.65 vol from a
 * contract priced at 0.08). Tail strikes are exactly what a hedging scanner
 * looks at, so the cheap approximation fails precisely where it matters.
 *
 * @param x - The point to evaluate at.
 * @returns P(Z <= x).
 */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;

  const z = Math.abs(x);
  let c: number;

  if (z > 37) {
    // Underflows to zero in double precision well before this.
    c = 0;
  } else {
    const e = Math.exp(-0.5 * z * z);
    if (z < 7.071067811865475) {
      let b = 3.52624965998911e-2 * z + 0.700383064443688;
      b = b * z + 6.37396220353165;
      b = b * z + 33.912866078383;
      b = b * z + 112.079291497871;
      b = b * z + 221.213596169931;
      b = b * z + 220.206867912376;

      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;

      c = (e * b) / d;
    } else {
      // Continued-fraction tail, for the far reaches where the rational form
      // loses relative precision.
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / (b * 2.506628274631);
    }
  }

  return x > 0 ? 1 - c : c;
}

/** The `d1`/`d2` pair, or `null` when the inputs are degenerate. */
function dPair(i: BsInputs): { d1: number; d2: number } | null {
  if (i.s <= 0 || i.k <= 0 || i.t <= 0 || i.sigma <= 0) return null;
  const vol = i.sigma * Math.sqrt(i.t);
  const d1 =
    (Math.log(i.s / i.k) + (i.r - i.q + 0.5 * i.sigma * i.sigma) * i.t) / vol;
  return { d1, d2: d1 - vol };
}

/** Intrinsic value at expiry, used as the degenerate-input answer. */
function intrinsic(i: BsInputs, right: OptionRight): number {
  return right === "call" ? Math.max(i.s - i.k, 0) : Math.max(i.k - i.s, 0);
}

/**
 * Black-Scholes-Merton price of a European option.
 *
 * @param i - Pricing inputs.
 * @param right - Call or put.
 * @returns The theoretical premium; the intrinsic value for degenerate inputs
 *   (zero time or zero vol).
 */
export function price(i: BsInputs, right: OptionRight): number {
  const d = dPair(i);
  if (!d) return intrinsic(i, right);

  const dfQ = Math.exp(-i.q * i.t);
  const dfR = Math.exp(-i.r * i.t);
  return right === "call"
    ? i.s * dfQ * normalCdf(d.d1) - i.k * dfR * normalCdf(d.d2)
    : i.k * dfR * normalCdf(-d.d2) - i.s * dfQ * normalCdf(-d.d1);
}

/**
 * Option delta.
 *
 * The whole 25-delta apparatus rests on this. Call delta is in `(0, 1)`, put
 * delta in `(-1, 0)`; callers comparing against a configured band such as
 * `[0.20, 0.30]` should compare against `Math.abs(delta)`.
 *
 * @param i - Pricing inputs.
 * @param right - Call or put.
 * @returns dPrice/dSpot.
 */
export function delta(i: BsInputs, right: OptionRight): number {
  const d = dPair(i);
  const dfQ = Math.exp(-i.q * i.t);
  if (!d) {
    // At zero time/vol delta collapses to the step function.
    const itm = right === "call" ? i.s > i.k : i.s < i.k;
    if (!itm) return 0;
    return right === "call" ? dfQ : -dfQ;
  }
  return right === "call" ? dfQ * normalCdf(d.d1) : dfQ * (normalCdf(d.d1) - 1);
}

/**
 * Vega: sensitivity to a 1.00 (i.e. 100 percentage-point) change in volatility.
 *
 * Divide by 100 for the "per vol point" figure traders quote. Used to drive the
 * Newton step in {@link impliedVolatility}.
 *
 * @param i - Pricing inputs.
 * @returns dPrice/dSigma.
 */
export function vega(i: BsInputs): number {
  const d = dPair(i);
  if (!d) return 0;
  return i.s * Math.exp(-i.q * i.t) * normalPdf(d.d1) * Math.sqrt(i.t);
}

/** Volatility search bounds. Anything outside is not a real market. */
const MIN_SIGMA = 1e-4;
const MAX_SIGMA = 5;
const MAX_ITERATIONS = 100;

/** Used only to test whether a target price is attainable at all. */
const PRICE_TOLERANCE = 1e-8;

/**
 * Convergence is measured on sigma, not on the price residual.
 *
 * Stopping once the premium is within 1e-8 of target sounds equivalent and is
 * not: the sigma it implies is uncertain by `1e-8 / vega`, so on a low-vega
 * wing contract (vega ~ 5e-4) a "converged" solve is still wrong in the fifth
 * decimal of vol. Bracketing on sigma makes accuracy independent of vega.
 */
const SIGMA_TOLERANCE = 1e-10;

/**
 * Below this vega, a price carries no recoverable volatility information.
 *
 * A deep-in-the-money, short-dated contract is priced almost entirely by its
 * intrinsic value: its premium barely moves as vol goes from 8% to 65%, so
 * *no* solver can tell those apart, and one that returns a number anyway is
 * fabricating it. At vega below 1e-4 a full vol point moves the premium by less
 * than 1e-6 — under the pricing tolerance — so the answer is noise.
 *
 * This is why vol surfaces are built from out-of-the-money contracts, and why
 * the metrics layer only ever solves IV on the OTM wing of each chain.
 */
const MIN_IDENTIFIABLE_VEGA = 1e-4;

/**
 * Invert Black-Scholes for implied volatility.
 *
 * Newton-Raphson accelerated, but bracketed by bisection so it cannot diverge:
 * deep out-of-the-money contracts have near-zero vega, and an unguarded Newton
 * step there happily shoots to a negative or absurd sigma. The bracket keeps
 * every iterate inside `[MIN_SIGMA, MAX_SIGMA]` and guarantees convergence.
 *
 * Returns `null` — rather than a made-up number — in the two cases where an
 * answer would be fiction:
 *
 *  1. No volatility can produce the observed price: a premium below intrinsic
 *     (a crossed or stale market) or above the no-arbitrage ceiling.
 *  2. The price carries no volatility information at all, because vega has
 *     collapsed (see {@link MIN_IDENTIFIABLE_VEGA}). A deep-ITM weekly is the
 *     canonical case — its premium is all intrinsic, and a solver asked to
 *     invert it will happily return 65% vol for a contract priced at 8%.
 *
 * A scanner acting on a fabricated IV is strictly worse than one that skips the
 * strike, so both cases decline to answer.
 *
 * @param target - The observed premium (use the bid/ask midpoint, not last).
 * @param i - Pricing inputs; `sigma` is ignored.
 * @param right - Call or put.
 * @returns The implied volatility, or `null` when it is not recoverable.
 */
export function impliedVolatility(
  target: number,
  i: Omit<BsInputs, "sigma">,
  right: OptionRight,
): number | null {
  if (!Number.isFinite(target) || target <= 0) return null;
  if (i.s <= 0 || i.k <= 0 || i.t <= 0) return null;

  const at = (sigma: number) => price({ ...i, sigma }, right);

  // No solution exists outside the price range the model can produce.
  const lo = at(MIN_SIGMA);
  const hi = at(MAX_SIGMA);
  if (target <= lo - PRICE_TOLERANCE || target >= hi + PRICE_TOLERANCE) {
    return null;
  }

  // If the premium hardly moves across the entire volatility range, the price
  // pins down no vol at all and any root we return is an artefact of where the
  // iteration happened to stop. Decline instead.
  if (hi - lo < PRICE_TOLERANCE) return null;

  let low = MIN_SIGMA;
  let high = MAX_SIGMA;
  // Brenner-Subrahmanyam ATM approximation as the opening guess.
  let sigma = Math.min(
    MAX_SIGMA,
    Math.max(MIN_SIGMA, (target / i.s) * Math.sqrt((2 * Math.PI) / i.t)),
  );

  /**
   * Accept a root only if the contract actually carries vol information there.
   * Guarding at the *solution* rather than up front is deliberate: a far-OTM
   * tail put has small vega too, but not vanishing vega, and those are precisely
   * the strikes a hedging scanner exists to price.
   */
  const accept = (candidate: number): number | null =>
    vega({ ...i, sigma: candidate }) < MIN_IDENTIFIABLE_VEGA ? null : candidate;

  for (let n = 0; n < MAX_ITERATIONS; n += 1) {
    const diff = at(sigma) - target;

    // An exact hit in double precision; no further information is available.
    if (diff === 0) return accept(sigma);

    // Maintain the bracket regardless of which way Newton wants to go.
    if (diff > 0) high = sigma;
    else low = sigma;

    if (high - low < SIGMA_TOLERANCE) return accept(0.5 * (low + high));

    const v = vega({ ...i, sigma });
    const next = v > 1e-8 ? sigma - diff / v : Number.NaN;

    // Fall back to bisection whenever Newton would leave the bracket.
    sigma =
      Number.isFinite(next) && next > low && next < high
        ? next
        : 0.5 * (low + high);
  }
  return accept(sigma);
}
