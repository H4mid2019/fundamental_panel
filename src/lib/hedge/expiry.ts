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

/** The two families of tenor, which have genuinely different requirements. */
export interface TenorTargets {
  /**
   * Tenors used for wing metrics (25-delta skew, call/put spread). These MUST
   * resolve to standard monthlies — see the module comment.
   */
  skew: readonly number[];
  /**
   * Tenors used only for at-the-money metrics (constant-maturity ATM IV, term
   * slope, VRP). Any expiration will do: ATM strikes are listed on every expiry,
   * so a weekly's shallow ladder is harmless here. This is what brackets the
   * 30-day point from below, without which a constant-maturity 30d ATM IV could
   * only be extrapolated.
   */
  term: readonly number[];
}

/** An expiration chosen for one or more of the configured target tenors. */
export interface SelectedExpiry {
  /** `YYYY-MM-DD`. */
  expiration: string;
  /** The original date, for provider calls that want a `Date`. */
  date: Date;
  dte: number;
  standardMonthly: boolean;
  /** Every target DTE that resolved to this expiration, ascending. */
  targetDtes: number[];
  /**
   * Safe for 25-delta / wing metrics. True only for standard monthlies: a
   * weekly's strike ladder cannot reach a 25-delta strike, and a search on one
   * silently clamps to the ladder edge rather than failing.
   */
  usableForSkew: boolean;
}

/** Nearest entry of `pool` to `target` by DTE, or `undefined` if empty. */
function nearest<T extends { dte: number }>(
  pool: readonly T[],
  target: number,
): T | undefined {
  let best = pool[0];
  if (!best) return undefined;
  for (const c of pool) {
    if (Math.abs(c.dte - target) < Math.abs(best.dte - target)) best = c;
  }
  return best;
}

/**
 * Choose the expirations to capture.
 *
 * `skew` targets resolve against standard monthlies only (falling back to any
 * expiration, flagged `usableForSkew: false`, when a ticker lists no monthly at
 * all). `term` targets resolve against every listed expiration, weeklies
 * included.
 *
 * The two sets are then merged and deduped by expiration date, so an expiry that
 * serves both purposes is fetched once, not twice — each Yahoo call is an
 * expiration, and the per-ticker call budget is the size of this result.
 *
 * @param available - Every expiration the provider listed.
 * @param targets - The skew and term tenor lists.
 * @param minDte - Never select an expiration closer than this.
 * @param now - The capture instant, injected for deterministic tests.
 * @returns The chosen expirations, ascending by DTE. Empty when nothing is in range.
 */
export function selectExpiries(
  available: readonly Date[],
  targets: TenorTargets,
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

  const add = (
    pick: (typeof candidates)[number],
    target: number,
    forSkew: boolean,
  ): void => {
    const expiration = toIsoDate(pick.date);
    const existing = chosen.get(expiration);
    if (existing) {
      if (!existing.targetDtes.includes(target)) {
        existing.targetDtes.push(target);
        existing.targetDtes.sort((a, b) => a - b);
      }
      // An expiry picked for a term target AND a skew target is usable for skew
      // only if it is genuinely a monthly.
      existing.usableForSkew ||= forSkew && pick.monthly;
      return;
    }
    chosen.set(expiration, {
      expiration,
      date: pick.date,
      dte: pick.dte,
      standardMonthly: pick.monthly,
      targetDtes: [target],
      usableForSkew: forSkew && pick.monthly,
    });
  };

  // Skew tenors: monthlies only. A ticker with no monthly in range still gets
  // *something* (better a flagged reading than none), but it is marked unusable
  // for wing metrics so no 25-delta number is ever taken off a thin ladder.
  const skewPool = monthlies.length > 0 ? monthlies : candidates;
  for (const target of targets.skew) {
    const pick = nearest(skewPool, target);
    if (pick) add(pick, target, true);
  }

  // Term tenors: any expiration, because only ATM IV is read from them.
  for (const target of targets.term) {
    const pick = nearest(candidates, target);
    if (pick) add(pick, target, false);
  }

  return [...chosen.values()].sort((a, b) => a.dte - b.dte);
}
