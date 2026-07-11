/**
 * History backfill — make the ranks and z-scores work before a year of scans has
 * accumulated.
 *
 * IV rank needs 252 days of trailing observations, and on a fresh install there
 * are none, so `protectivePut` and `callCredit` (both gated on IV rank) return
 * nothing at all. That is correct but useless. This module fills the gap with the
 * only data that honestly exists.
 *
 * ── What can and cannot be backfilled ────────────────────────────────────────
 *
 * **Realized vol — yes, for everything.** We already fetch three years of daily
 * candles for every ticker, so the entire realized-vol and EWMA series can be
 * reconstructed today, exactly as a scan would have written it. This makes the
 * *proxied* IV rank computable immediately for all 85 tickers. It is still a
 * proxy — a realized-vol rank wearing an IV-rank costume — and it is still
 * flagged as one. But a flagged proxy that ranks is worth far more than a null.
 *
 * **Real implied vol — yes, but only for five tickers.** CBOE publishes 30-day
 * constant-maturity *implied* volatility indices, which is precisely what
 * `history.atm_iv` is defined to be. Yahoo carries usable history for exactly
 * five of them:
 *
 *     ^VIX  → SPY      ^VXN  → QQQ      ^VXD  → DIA
 *     ^GVZ  → GLD      ^OVX  → USO
 *
 * The single-name indices (^VXAPL, ^VXGOG, ^VXIBM, ...) return a single bar —
 * CBOE discontinued them. So for those five tickers IV rank becomes *genuinely*
 * non-proxied on day one, and for the other eighty it stays a flagged proxy until
 * real scans accumulate. There is no free source for the rest; per-name historical
 * implied vol is a paid product (ORATS, Polygon options, IVolatility, CBOE
 * DataShop).
 *
 * **Skew history — no.** There is no free historical 25-delta skew for any
 * underlying, at any price short of a full options-tick archive. `putDebitSpread`,
 * which ranks on the skew z-score, therefore has a cross-sectional fallback (see
 * `metrics/engine.ts`) until roughly 20 sessions of real skew accumulate.
 *
 * ── The calibration, and why it is needed ────────────────────────────────────
 *
 * A vol index is not the same measurement as our ATM IV. VIX is a variance-swap
 * strip across the *whole* surface, so it sits systematically above the ATM point
 * (the wings drag it up). Splicing raw VIX values onto a series that continues in
 * ATM IV would put a level discontinuity right at the join — and IV rank, which is
 * a position within a range, would read that discontinuity as a vol regime change
 * that never happened.
 *
 * So the index is level-calibrated to the ticker's own chain: the ratio of today's
 * measured ATM IV to today's index value scales the whole history. That preserves
 * the *shape* of the series — which is all a rank cares about — while putting it
 * on our units.
 */

import type { Candle } from "../chart/types";
import { logger } from "../logger";

import { getHedgeConfig } from "./config";
import type { HedgeDb } from "./db/client";
import { getChainAtmIvByDate, upsertHistory, type HistoryRow } from "./db/repo";
import { toIsoDate } from "./expiry";
import { ewmaVolatility, logReturns, realizedVolatility } from "./math/stats";
import { getUnderlying } from "./providers/underlying";

/**
 * Underlyings with a CBOE 30-day implied-volatility index that Yahoo actually
 * carries history for. Verified live — the single-name indices are discontinued
 * and return one bar, so they are deliberately absent.
 */
export const VOL_INDEX: Readonly<Record<string, string>> = {
  SPY: "^VIX",
  QQQ: "^VXN",
  DIA: "^VXD",
  GLD: "^GVZ",
  USO: "^OVX",
};

/** What happened to one ticker. */
export interface BackfillTicker {
  ticker: string;
  /** Rows written. */
  days: number;
  /** Whether real implied vol was available, or only a realized-vol proxy. */
  basis: "vol_index" | "realized_proxy";
  /** The vol index used, when one was. */
  volIndex: string | null;
  /** Ratio applied to put the index on our ATM-IV units. */
  calibration: number | null;
  error?: string;
}

/** The outcome of a backfill run. */
export interface BackfillResult {
  tickers: BackfillTicker[];
  totalDays: number;
  withRealIv: number;
  withProxyOnly: number;
}

/** Options, all injectable so the job is testable. */
export interface BackfillOptions {
  tickers?: readonly string[];
  db?: HedgeDb;
  now?: Date;
  /** Trading days to reconstruct. Defaults to the IV-rank lookback. */
  days?: number;
}

/**
 * Rebuild one ticker's daily observation series from its candles.
 *
 * Each row is computed exactly as a scan on that day would have computed it — the
 * realized vol and EWMA use only the candles available *up to* that day, never
 * later ones. Look-ahead here would be silent and fatal: an IV rank built on a
 * series that peeked at the future is a backtest that always wins.
 *
 * @param ticker - The underlying.
 * @param candles - Daily candles, ascending.
 * @param days - How many trailing rows to emit.
 * @param config - Supplies the EWMA decay and realized-vol window.
 * @returns The rows, oldest first.
 */
export function rebuildHistory(
  ticker: string,
  candles: readonly Candle[],
  days: number,
  config: { ewmaLambda: number; realizedVolWindowDays: number },
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  // EWMA needs a seed window; without at least this much history a row is noise.
  const minBars = 60;

  const start = Math.max(minBars, candles.length - days);

  for (let i = start; i < candles.length; i += 1) {
    const bar = candles[i];
    if (!bar) continue;

    // Only the past. Slicing to `i + 1` is what stops look-ahead.
    const window = candles.slice(0, i + 1);
    const closes = window.map((c) => c.close).filter((c) => c > 0);
    const returns = logReturns(closes);

    const realized = realizedVolatility(returns, config.realizedVolWindowDays);
    const ewma = ewmaVolatility(returns, config.ewmaLambda);
    if (realized === null && ewma === null) continue;

    rows.push({
      ticker,
      asOf: toIsoDate(new Date(bar.time * 1000)),
      close: bar.close,
      // No chain existed on that day, so there is no real ATM IV. The vol-index
      // pass below fills this in where it can; otherwise it stays null and the
      // row remains an explicitly proxied observation.
      atmIv: null,
      atmIvProxied: true,
      atmIvBasis: "realized_proxy",
      realizedVol20d: realized,
      ewmaVol: ewma,
      vrp: null,
      putSkew25d: null,
      callPutSpread: null,
      termSlope: null,
      source: "backfill",
    });
  }

  return rows;
}

/**
 * Overlay real implied vol from a CBOE index onto a rebuilt series.
 *
 * @param rows - Rows from {@link rebuildHistory}, oldest first.
 * @param indexCandles - The vol index's daily candles (values are in vol points).
 * @param calibration - Ratio scaling the index onto our ATM-IV units.
 * @returns The rows, with `atmIv` filled in wherever the index has a value.
 */
export function overlayVolIndex(
  rows: readonly HistoryRow[],
  indexCandles: readonly Candle[],
  calibration: number,
): HistoryRow[] {
  const byDate = new Map<string, number>();
  for (const c of indexCandles) {
    if (c.close > 0) byDate.set(toIsoDate(new Date(c.time * 1000)), c.close);
  }

  return rows.map((row) => {
    const index = byDate.get(row.asOf);
    if (index === undefined) return row;

    const atmIv = index * calibration;
    if (!Number.isFinite(atmIv) || atmIv <= 0) return row;

    return {
      ...row,
      atmIv,
      // A CBOE implied-vol index IS implied vol. It is measured by CBOE rather
      // than by us, and rebased onto our units, but it is not a realized-vol
      // stand-in — so it legitimately matures the IV rank.
      atmIvProxied: false,
      atmIvBasis: "vol_index",
      // VRP is computable historically too, once real implied vol exists.
      vrp: row.ewmaVol !== null ? atmIv - row.ewmaVol : null,
    };
  });
}

/**
 * Default ratio of ATM implied vol to its CBOE index.
 *
 * A vol index is a variance-swap strip across the *whole* surface, so the wings
 * drag it above the at-the-money point. Measured live: SPY's 30-day ATM IV was
 * 13.3% against a VIX of 15.03 — a ratio of 0.89. This constant is the
 * approximation used only until a real scan has measured the ticker's own ATM IV,
 * after which {@link calibrate} uses that instead.
 *
 * Note what this must NOT be: the ratio of realized vol to the index. Options
 * normally trade above realized (that is the variance risk premium), so anchoring
 * the backfilled series on realized vol would scale the whole history down to
 * realized and erase the very premium VRP exists to measure.
 */
const DEFAULT_ATM_TO_INDEX = 0.9;

/**
 * The ratio that puts a vol index on this ticker's ATM-IV units.
 *
 * Prefers the ticker's own **measured** ATM IV, from days where a real scan wrote
 * a chain-based observation and the index also has a value. That is a like-for-
 * like comparison of the two measurements on the same day, which is exactly what
 * a level calibration wants. Falls back to {@link DEFAULT_ATM_TO_INDEX} before any
 * scan has run — which is the common case, since a backfill is the first thing you
 * do on a fresh install.
 *
 * The calibration only fixes the LEVEL. A rank reads the *shape* of a series, and
 * scaling by a constant leaves the shape untouched.
 *
 * @param ticker - The underlying.
 * @param indexCandles - The vol index's candles.
 * @param db - Database handle.
 * @returns The scaling ratio.
 */
function calibrate(
  ticker: string,
  indexCandles: readonly Candle[],
  db?: HedgeDb,
): number {
  const measured = getChainAtmIvByDate(ticker, db);
  if (measured.size === 0) return DEFAULT_ATM_TO_INDEX;

  const ratios: number[] = [];
  for (const c of indexCandles) {
    if (c.close <= 0) continue;
    const atmIv = measured.get(toIsoDate(new Date(c.time * 1000)));
    if (atmIv === undefined || atmIv <= 0) continue;
    ratios.push(atmIv / c.close);
  }

  // No same-day overlap is the COMMON case, not an edge one: a scan run on a
  // Saturday stamps its row with Saturday, while the index's last bar is Friday.
  // Falling straight through to the default would then waste a perfectly good
  // measurement. Compare the two most recent observations instead — a day apart
  // is immaterial for a level calibration.
  if (ratios.length === 0) {
    const lastIndex = [...indexCandles]
      .reverse()
      .find((c) => c.close > 0)?.close;
    const lastMeasured = [...measured.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )[measured.size - 1]?.[1];

    if (
      lastIndex !== undefined &&
      lastMeasured !== undefined &&
      lastIndex > 0
    ) {
      ratios.push(lastMeasured / lastIndex);
    }
  }

  if (ratios.length === 0) return DEFAULT_ATM_TO_INDEX;

  // Median: one bad scan day must not tilt the whole history.
  ratios.sort((a, b) => a - b);
  const mid = ratios[Math.floor(ratios.length / 2)] ?? DEFAULT_ATM_TO_INDEX;

  // A ratio outside this band means one of the two measurements is broken, not
  // that the surface has an exotic shape.
  return Math.min(1.5, Math.max(0.5, mid));
}

/**
 * Backfill the observation history for the universe.
 *
 * Run a scan **first** if you can: that gives every vol-index ticker a measured
 * ATM IV to calibrate against, instead of the generic {@link DEFAULT_ATM_TO_INDEX}.
 * Re-running the backfill later recalibrates against whatever scans have since
 * accumulated, so it is idempotent and improves with age.
 *
 * @param options - Tickers, database, and how far back to go.
 * @returns What was written, per ticker. Never throws.
 */
export async function runBackfill(
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const config = getHedgeConfig();
  const now = options.now ?? new Date();
  const db = options.db;
  const tickers = options.tickers ?? config.universe;
  const days = options.days ?? config.metrics.ivRankLookbackDays;

  const results: BackfillTicker[] = [];

  for (const ticker of tickers) {
    try {
      const u = await getUnderlying(ticker, now);
      if (!u.ok || u.data.candles.length < 60) {
        results.push({
          ticker,
          days: 0,
          basis: "realized_proxy",
          volIndex: null,
          calibration: null,
          error: u.ok ? "not enough candles" : u.error.message,
        });
        continue;
      }

      let rows = rebuildHistory(ticker, u.data.candles, days, config.metrics);
      let basis: BackfillTicker["basis"] = "realized_proxy";
      let calibration: number | null = null;
      const indexSymbol = VOL_INDEX[ticker] ?? null;

      if (indexSymbol) {
        const idx = await getUnderlying(indexSymbol, now);
        if (idx.ok && idx.data.candles.length > 0) {
          calibration = calibrate(ticker, idx.data.candles, db);
          rows = overlayVolIndex(rows, idx.data.candles, calibration);
          basis = "vol_index";
        } else {
          logger.warn("hedge.backfill: vol index unavailable", {
            ticker,
            indexSymbol,
          });
        }
      }

      upsertHistory(rows, db);
      results.push({
        ticker,
        days: rows.length,
        basis,
        volIndex: basis === "vol_index" ? indexSymbol : null,
        calibration,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("hedge.backfill: ticker failed", { ticker, error: message });
      results.push({
        ticker,
        days: 0,
        basis: "realized_proxy",
        volIndex: null,
        calibration: null,
        error: message,
      });
    }
  }

  const totalDays = results.reduce((a, r) => a + r.days, 0);
  const withRealIv = results.filter((r) => r.basis === "vol_index").length;

  logger.info("hedge.backfill.done", {
    tickers: results.length,
    totalDays,
    withRealIv,
  });

  return {
    tickers: results,
    totalDays,
    withRealIv,
    withProxyOnly: results.length - withRealIv,
  };
}
