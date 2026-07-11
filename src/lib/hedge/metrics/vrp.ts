/**
 * Variance risk premium — the "is hedging actually cheap right now" number.
 *
 *   VRP = ATM_IV_30d - EWMA_realized_vol      (both in vol points)
 *
 * **This is not redundant with IV rank, and the two routinely disagree.** IV rank
 * asks "cheap versus its own history?"; VRP asks "cheap versus what volatility is
 * actually doing?". A name can sit in the 10th percentile of its own IV range
 * while realized vol runs *above* implied — historically cheap options that are
 * nonetheless underpricing reality. Buying protection there looks like a bargain
 * on IV rank and is not one. Both numbers are therefore displayed, never one in
 * place of the other.
 *
 * VRP also has a practical virtue during the history-accumulation period: it
 * needs no stored IV history at all, only today's chain and the candle series. So
 * while IV rank is still a realized-vol proxy wearing a costume, VRP is already
 * telling the truth — which makes it the honest signal on day one.
 */

import { ewmaVolatility, logReturns, zScore } from "../math/stats";

/** The VRP reading for one ticker. */
export interface VrpReading {
  /** ATM IV at a constant 30-day maturity, in vol points. `null` if unbracketed. */
  atmIv30: number | null;
  /** EWMA realized-volatility forecast, in vol points. */
  ewmaVol: number | null;
  /** ATM_IV_30d - EWMA_RV, in vol points. Positive = options rich. */
  vrp: number | null;
  /** VRP versus its own trailing history. */
  vrpZ: number | null;
  /**
   * Plain-language reading, for the UI.
   * `rich`: options expensive relative to realized — good to sell, dear to hedge.
   * `cheap`: protection is underpriced relative to what vol is actually doing.
   */
  state: "rich" | "fair" | "cheap" | "unknown";
}

/** Vol points of VRP within which the market is neither rich nor cheap. */
const FAIR_BAND = 1.0;

/**
 * Compute the variance risk premium.
 *
 * @param atmIv30 - Constant-maturity 30-day ATM IV as a decimal (0.18 = 18%), or
 *   `null` when the chain did not bracket the 30-day point.
 * @param closes - Daily closes, oldest first.
 * @param lambda - EWMA decay (0.94 = RiskMetrics daily).
 * @param vrpHistory - Trailing VRP observations, for the z-score.
 * @returns The reading, with `null`s wherever an input was missing.
 */
export function computeVrp(
  atmIv30: number | null,
  closes: readonly number[],
  lambda: number,
  vrpHistory: readonly number[],
): VrpReading {
  const ewmaVol = ewmaVolatility(logReturns([...closes]), lambda);

  // Both legs must be in the same units or the subtraction is meaningless.
  // `atmIv30` arrives as a decimal; EWMA is already in vol points (percent).
  const ivPoints = atmIv30 !== null ? atmIv30 * 100 : null;

  const vrp = ivPoints !== null && ewmaVol !== null ? ivPoints - ewmaVol : null;

  const vrpZ =
    vrp !== null && vrpHistory.length >= 20 ? zScore(vrp, vrpHistory) : null;

  const state: VrpReading["state"] =
    vrp === null
      ? "unknown"
      : vrp > FAIR_BAND
        ? "rich"
        : vrp < -FAIR_BAND
          ? "cheap"
          : "fair";

  return { atmIv30: ivPoints, ewmaVol, vrp, vrpZ, state };
}
