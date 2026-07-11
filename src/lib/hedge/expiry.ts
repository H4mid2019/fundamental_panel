/**
 * Expiration selection.
 *
 * The load-bearing rule here is *prefer standard monthlies*. Yahoo lists weekly
 * expirations alongside monthlies, but a weekly's strike ladder is far shallower:
 * on a live AAPL pull the 2026-08-14 weekly listed strikes 200-335, while the
 * 2026-08-21 monthly listed 110-600. A 25-delta strike search on the weekly
 * cannot reach far enough down the ladder, so it silently returns the deepest
 * available strike as if it were the 25-delta one. Every skew number downstream
 * would then be quietly wrong rather than absent, which is the worse failure.
 *
 * So: for each configured target DTE we pick the nearest standard monthly at or
 * beyond `minDte`, and only fall back to a weekly when a ticker lists no monthly
 * in range at all (recording that fact on the expiry so callers can discount it).
 */

/** Milliseconds in a day. */
const DAY_MS = 86_400_000;

/**
 * Is this date a standard monthly expiration (the third Friday of its month)?
 *
 * Uses UTC parts throughout: Yahoo hands back expirations as UTC midnight, and
 * reading them with local getters shifts the date by a day west of Greenwich —
 * which would misclassify every monthly as a Thursday.
 *
 * @param date - The expiration date.
 * @returns True when `date` is the third Friday of its month.
 */
export function isStandardMonthly(date: Date): boolean {
  if (date.getUTCDay() !== 5) return false; // not a Friday
  const dom = date.getUTCDate();
  return dom >= 15 && dom <= 21; // the only Friday in this window is the third
}

/** Whole days between two instants, rounded to the nearest day. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

/** Format a date as `YYYY-MM-DD` in UTC. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** An expiration chosen for one of the configured target tenors. */
export interface SelectedExpiry {
  /** `YYYY-MM-DD`. */
  expiration: string;
  /** The original date, for provider calls that want a `Date`. */
  date: Date;
  dte: number;
  standardMonthly: boolean;
  /** Which entry of `chain.targetDte` selected this expiration. */
  targetDte: number;
}

/**
 * Choose one expiration per target tenor.
 *
 * For each target DTE, prefers the standard monthly whose DTE is closest to the
 * target (subject to `minDte`); if the ticker lists no monthly at or beyond
 * `minDte`, falls back to the closest non-monthly so a thin-chain ticker still
 * produces *something*, flagged `standardMonthly: false`.
 *
 * Two targets that resolve to the same expiration are deduped — SPY's 30d and
 * 90d targets can land on the same monthly for a thinly-listed name, and we
 * should not pay for the same HTTP call twice.
 *
 * @param available - Every expiration the provider listed.
 * @param targetDtes - Desired tenors, in days (e.g. `[30, 90, 180]`).
 * @param minDte - Never select an expiration closer than this.
 * @param now - The capture instant, injected for deterministic tests.
 * @returns The chosen expirations, ascending by DTE. Empty when nothing is in range.
 */
export function selectExpiries(
  available: readonly Date[],
  targetDtes: readonly number[],
  minDte: number,
  now: Date,
): SelectedExpiry[] {
  const candidates = available
    .map((date) => ({
      date,
      dte: daysBetween(now, date),
      monthly: isStandardMonthly(date),
    }))
    .filter((c) => c.dte >= minDte)
    .sort((a, b) => a.dte - b.dte);

  if (candidates.length === 0) return [];

  const monthlies = candidates.filter((c) => c.monthly);
  const chosen = new Map<string, SelectedExpiry>();

  for (const target of targetDtes) {
    // Prefer monthlies; only consider weeklies if the ticker lists no monthly.
    const pool = monthlies.length > 0 ? monthlies : candidates;
    let best = pool[0];
    if (!best) continue;
    for (const c of pool) {
      if (Math.abs(c.dte - target) < Math.abs(best.dte - target)) best = c;
    }

    const expiration = toIsoDate(best.date);
    const existing = chosen.get(expiration);
    // If two targets collide on one expiration, keep it under the target it
    // matches most closely, so `targetDte` stays meaningful downstream.
    if (
      existing &&
      Math.abs(best.dte - existing.targetDte) <= Math.abs(best.dte - target)
    ) {
      continue;
    }
    chosen.set(expiration, {
      expiration,
      date: best.date,
      dte: best.dte,
      standardMonthly: best.monthly,
      targetDte: target,
    });
  }

  return [...chosen.values()].sort((a, b) => a.dte - b.dte);
}
