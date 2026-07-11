/**
 * Interpolation for the volatility surface.
 *
 * Neither a true 25-delta strike nor a true 30-day expiry exists in a real chain,
 * so both must be interpolated — and *how* decides whether the skew and
 * term-structure metrics are unbiased or quietly wrong.
 *
 * Two rules govern everything here:
 *
 *  1. **Never extrapolate.** If the chain does not bracket the target on both
 *     sides, the answer is `null` and the caller skips the ticker/expiry with a
 *     warning. Clamping to the edge of the ladder yields a number that looks like
 *     a 25-delta IV, is not one, and is indistinguishable from the real thing
 *     downstream. Absent beats wrong.
 *
 *  2. **Interpolate in the right space.** Across strikes, in delta space with a
 *     shape-preserving (monotone) spline. Across expiries, in *total variance* —
 *     linearly interpolating IV against calendar days is mildly arbitrageable and
 *     biases the term slope.
 */

/** A point on a curve to be interpolated. */
export interface Point {
  x: number;
  y: number;
}

/**
 * Monotone cubic Hermite interpolation (Fritsch-Carlson, "PCHIP").
 *
 * A natural cubic spline through a volatility smile overshoots: it will happily
 * invent a local minimum between two strikes and hand back an IV lower than
 * either neighbour, which is not a smile any market ever quoted. PCHIP chooses
 * tangents that preserve the shape of the data — where the inputs are monotone
 * the output is monotone, and it never overshoots the bracketing values. That is
 * exactly the guarantee an IV curve needs.
 *
 * @param points - Knots, which will be sorted and de-duplicated by `x`.
 * @param x - Where to evaluate.
 * @returns The interpolated `y`, or `null` when `x` is outside the data range
 *   (this function does not extrapolate) or there are too few points.
 */
export function pchip(points: readonly Point[], x: number): number | null {
  if (!Number.isFinite(x)) return null;

  // Sort by x and drop duplicates — two strikes can round to the same delta, and
  // a zero-width interval would divide by zero below.
  const knots: Point[] = [];
  for (const p of [...points].sort((a, b) => a.x - b.x)) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = knots[knots.length - 1];
    if (last && Math.abs(p.x - last.x) < 1e-12) continue;
    knots.push({ x: p.x, y: p.y });
  }

  const n = knots.length;
  if (n === 0) return null;

  const first = knots[0];
  const lastKnot = knots[n - 1];
  if (!first || !lastKnot) return null;

  // Strictly no extrapolation.
  if (x < first.x || x > lastKnot.x) return null;
  if (n === 1) return first.y;

  // Secant slopes and interval widths.
  const h: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = knots[i];
    const b = knots[i + 1];
    if (!a || !b) return null;
    const width = b.x - a.x;
    h.push(width);
    slope.push((b.y - a.y) / width);
  }

  if (n === 2) {
    // Two points: linear, which is already monotone and shape-preserving.
    const s = slope[0];
    if (s === undefined) return null;
    return first.y + s * (x - first.x);
  }

  // Fritsch-Carlson tangents.
  const m: number[] = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    const sPrev = slope[i - 1];
    const sCur = slope[i];
    const hPrev = h[i - 1];
    const hCur = h[i];
    if (
      sPrev === undefined ||
      sCur === undefined ||
      hPrev === undefined ||
      hCur === undefined
    ) {
      return null;
    }
    // A sign change (or a flat) means a local extremum: a zero tangent there is
    // what stops the spline overshooting into a value the data never supports.
    if (sPrev * sCur <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * hCur + hPrev;
      const w2 = hCur + 2 * hPrev;
      m[i] = (w1 + w2) / (w1 / sPrev + w2 / sCur);
    }
  }

  // One-sided endpoint tangents, clamped so the ends cannot overshoot either.
  const endpoint = (hA: number, hB: number, sA: number, sB: number): number => {
    const t = ((2 * hA + hB) * sA - hA * sB) / (hA + hB);
    if (t * sA <= 0) return 0;
    if (sA * sB <= 0 && Math.abs(t) > 3 * Math.abs(sA)) return 3 * sA;
    return t;
  };

  const h0 = h[0];
  const h1 = h[1];
  const s0 = slope[0];
  const s1 = slope[1];
  const hLast = h[n - 2];
  const hPrevLast = h[n - 3];
  const sLast = slope[n - 2];
  const sPrevLast = slope[n - 3];
  if (
    h0 === undefined ||
    h1 === undefined ||
    s0 === undefined ||
    s1 === undefined ||
    hLast === undefined ||
    hPrevLast === undefined ||
    sLast === undefined ||
    sPrevLast === undefined
  ) {
    return null;
  }
  m[0] = endpoint(h0, h1, s0, s1);
  m[n - 1] = endpoint(hLast, hPrevLast, sLast, sPrevLast);

  // Locate the interval containing x.
  let i = 0;
  for (let k = 0; k < n - 1; k += 1) {
    const b = knots[k + 1];
    if (b && x <= b.x) {
      i = k;
      break;
    }
    i = k;
  }

  const a = knots[i];
  const b = knots[i + 1];
  const hi = h[i];
  const mA = m[i];
  const mB = m[i + 1];
  if (
    !a ||
    !b ||
    hi === undefined ||
    mA === undefined ||
    mB === undefined ||
    hi === 0
  ) {
    return null;
  }

  // Cubic Hermite basis.
  const t = (x - a.x) / hi;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;

  return h00 * a.y + h10 * hi * mA + h01 * b.y + h11 * hi * mB;
}

/** One listed strike, with its solved IV and absolute delta. */
export interface DeltaPoint {
  strike: number;
  /** Implied volatility as a decimal. */
  iv: number;
  /** |delta|, in (0, 1). */
  absDelta: number;
}

/** An IV read off the smile at a target delta. */
export interface DeltaInterpolation {
  /** Interpolated implied volatility at exactly the target delta. */
  iv: number;
  /** The nearest genuinely listed strike — what a scanner must actually trade. */
  nearestStrike: number;
}

/**
 * Interpolate IV at a target delta, in delta space, with a monotone spline.
 *
 * Real chains are quantized — a name with $5 strike spacing can jump from 0.22 to
 * 0.31 delta with nothing between — so the nearest *listed* strike is a different
 * moneyness on every ticker, and comparing "25-delta IV" across the universe
 * would be comparing different things. Interpolating in delta space puts every
 * ticker on the same footing.
 *
 * **Requires bracketing.** If the chain's deltas do not straddle the target the
 * result is `null`, never an extrapolation. This is the guard that stops a thin
 * weekly ladder — which cannot reach 25 delta at all — from silently returning
 * its deepest listed strike as though it were the 25-delta one.
 *
 * @param points - Listed strikes with solved IV and |delta|, in any order.
 * @param targetDelta - Absolute delta to solve for (e.g. 0.25).
 * @returns The interpolated IV and nearest tradable strike, or `null` when the
 *   chain does not bracket the target.
 */
export function ivAtDelta(
  points: readonly DeltaPoint[],
  targetDelta: number,
): DeltaInterpolation | null {
  const usable = points.filter(
    (p) =>
      Number.isFinite(p.iv) &&
      Number.isFinite(p.absDelta) &&
      p.iv > 0 &&
      p.absDelta > 0 &&
      p.absDelta < 1,
  );
  if (usable.length < 2) return null;

  const deltas = usable.map((p) => p.absDelta);
  const lo = Math.min(...deltas);
  const hi = Math.max(...deltas);
  // No bracket, no answer.
  if (targetDelta < lo || targetDelta > hi) return null;

  const iv = pchip(
    usable.map((p) => ({ x: p.absDelta, y: p.iv })),
    targetDelta,
  );
  if (iv === null || !Number.isFinite(iv) || iv <= 0) return null;

  let nearest = usable[0];
  if (!nearest) return null;
  for (const p of usable) {
    if (
      Math.abs(p.absDelta - targetDelta) <
      Math.abs(nearest.absDelta - targetDelta)
    ) {
      nearest = p;
    }
  }

  return { iv, nearestStrike: nearest.strike };
}

/** An ATM IV observation at one expiry. */
export interface TenorPoint {
  /** Time to expiry in years. */
  t: number;
  /** ATM implied volatility as a decimal. */
  iv: number;
}

/**
 * Interpolate a constant-maturity ATM IV by linear interpolation in **total
 * variance**.
 *
 *   w(T) = sigma(T)^2 * T                          (total variance)
 *   w    = w1 + (w2 - w1) * (T - T1) / (T2 - T1)   (linear in T)
 *   sigma(T) = sqrt(w / T)
 *
 * Interpolating IV linearly against calendar days instead is the intuitive thing
 * to do and is wrong: total variance must be non-decreasing in time or the
 * surface admits a calendar-spread arbitrage, and linear-in-IV does not respect
 * that. Since the term-structure slope is *defined* as a difference of two
 * interpolated IVs, any bias here lands squarely on the metric.
 *
 * **Requires bracketing** — see the module comment.
 *
 * @param points - ATM IV per captured expiry, in any order.
 * @param t - Target maturity in years (e.g. 30/365).
 * @returns The constant-maturity ATM IV, or `null` when the expiries do not
 *   bracket `t`.
 */
export function atmIvAtTenor(
  points: readonly TenorPoint[],
  t: number,
): number | null {
  if (!Number.isFinite(t) || t <= 0) return null;

  const usable = [...points]
    .filter(
      (p) =>
        Number.isFinite(p.t) && Number.isFinite(p.iv) && p.t > 0 && p.iv > 0,
    )
    .sort((a, b) => a.t - b.t);
  if (usable.length === 0) return null;

  const first = usable[0];
  const last = usable[usable.length - 1];
  if (!first || !last) return null;
  if (t < first.t || t > last.t) return null;

  // A single expiry can only answer for its own maturity — and the bounds check
  // above has already established that `t` is exactly it.
  if (usable.length === 1) return first.iv;

  // Find the bracketing pair.
  for (let i = 0; i < usable.length - 1; i += 1) {
    const a = usable[i];
    const b = usable[i + 1];
    if (!a || !b) return null;
    if (t < a.t || t > b.t) continue;

    // Exact hits need no interpolation (and t === a.t would divide by zero).
    if (Math.abs(t - a.t) < 1e-12) return a.iv;
    if (Math.abs(t - b.t) < 1e-12) return b.iv;

    const wA = a.iv * a.iv * a.t;
    const wB = b.iv * b.iv * b.t;
    const w = wA + ((wB - wA) * (t - a.t)) / (b.t - a.t);
    if (w <= 0) return null;
    return Math.sqrt(w / t);
  }

  return null;
}
