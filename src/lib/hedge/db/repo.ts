/**
 * Repository layer: every SQL statement HedgeScope runs lives here.
 *
 * Callers pass domain objects and get domain objects back; nothing above this
 * file knows about SQLite. Chain snapshots are gzipped on write and inflated on
 * read, which keeps a 60-ticker scan's raw chains in the low single-digit MB.
 */

import { gunzipSync, gzipSync } from "node:zlib";

import { logger } from "../../logger";
import type { TickerMetrics } from "../metrics/engine";
import type { PairMetric } from "../metrics/pairs";
import type { Setup } from "../scanners/types";
import type { ChainSnapshot } from "../types";

import { getDb, type HedgeDb, type Param } from "./client";

/** How a scan was started. */
export type ScanTrigger = "cron" | "manual" | "backfill";

/** Terminal state of a scan. `partial` means some tickers were skipped. */
export type ScanStatus = "running" | "ok" | "partial" | "failed";

/** A scan row. */
export interface ScanRecord {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  trigger: ScanTrigger;
  status: ScanStatus;
  tickersOk: number;
  tickersFailed: number;
  error: string | null;
}

/** One day's observations for one ticker — the series z-scores are built on. */
export interface HistoryRow {
  ticker: string;
  /** `YYYY-MM-DD`. */
  asOf: string;
  close: number | null;
  /** Constant-maturity 30-day ATM IV, in vol points. */
  atmIv: number | null;
  /** True when `atmIv` is a realized-vol stand-in rather than a real ATM IV. */
  atmIvProxied: boolean;
  /**
   * Where `atmIv` came from. `realized_proxy` must NEVER mature the IV rank —
   * that would be the proxy certifying itself as the real thing.
   */
  atmIvBasis: "chain" | "vol_index" | "realized_proxy" | null;
  realizedVol20d: number | null;
  /** EWMA (RiskMetrics) realized-vol forecast, in vol points. */
  ewmaVol: number | null;
  /** Variance risk premium, in vol points. */
  vrp: number | null;
  putSkew25d: number | null;
  callPutSpread: number | null;
  termSlope: number | null;
  source: "scan" | "backfill";
}

const nowIso = (): string => new Date().toISOString();

const toBool = (v: unknown): boolean => v === 1 || v === true;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/* ── scans ─────────────────────────────────────────────────────────────────── */

/**
 * Open a new scan row in the `running` state.
 *
 * @param trigger - What started this scan.
 * @param db - Database handle (defaults to the shared one).
 * @returns The new scan's id.
 */
export function startScan(trigger: ScanTrigger, db: HedgeDb = getDb()): number {
  db.run(
    `INSERT INTO scans (started_at, trigger, status) VALUES (:startedAt, :trigger, 'running')`,
    { startedAt: nowIso(), trigger },
  );
  const row = db.get<{ id: number }>("SELECT last_insert_rowid() AS id");
  if (!row) throw new Error("hedge.db: could not create scan row");
  return row.id;
}

/**
 * Close out a scan.
 *
 * @param scanId - The scan to finish.
 * @param result - Terminal status and per-ticker counts.
 * @param db - Database handle.
 */
export function finishScan(
  scanId: number,
  result: {
    status: ScanStatus;
    tickersOk: number;
    tickersFailed: number;
    error?: string;
  },
  db: HedgeDb = getDb(),
): void {
  db.run(
    `UPDATE scans
        SET finished_at = :finishedAt,
            status = :status,
            tickers_ok = :ok,
            tickers_failed = :failed,
            error = :error
      WHERE id = :id`,
    {
      id: scanId,
      finishedAt: nowIso(),
      status: result.status,
      ok: result.tickersOk,
      failed: result.tickersFailed,
      error: result.error ?? null,
    },
  );
}

/** Map a raw scan row into a {@link ScanRecord}. */
function mapScan(r: Record<string, unknown>): ScanRecord {
  return {
    id: Number(r.id),
    startedAt: String(r.started_at),
    finishedAt: r.finished_at === null ? null : String(r.finished_at),
    trigger: r.trigger as ScanTrigger,
    status: r.status as ScanStatus,
    tickersOk: Number(r.tickers_ok),
    tickersFailed: Number(r.tickers_failed),
    error: r.error === null ? null : String(r.error),
  };
}

/**
 * Fetch the most recent completed scan.
 *
 * @param db - Database handle.
 * @returns The latest finished scan, or `null` when none has completed.
 */
export function getLatestScan(db: HedgeDb = getDb()): ScanRecord | null {
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM scans WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
  );
  return row ? mapScan(row) : null;
}

/**
 * List recent scans, newest first.
 *
 * @param limit - Maximum rows to return.
 * @param db - Database handle.
 * @returns The scan history.
 */
export function listScans(limit = 20, db: HedgeDb = getDb()): ScanRecord[] {
  return db
    .all<
      Record<string, unknown>
    >(`SELECT * FROM scans ORDER BY started_at DESC LIMIT :limit`, { limit })
    .map(mapScan);
}

/* ── chain snapshots ───────────────────────────────────────────────────────── */

/**
 * Persist a raw chain snapshot, gzipped.
 *
 * The snapshot is stored verbatim — including contracts the quality filter will
 * later reject — so a metric can be recomputed after a bug fix without going
 * back to Yahoo.
 *
 * @param scanId - Owning scan.
 * @param snapshot - The captured chain.
 * @param db - Database handle.
 * @returns The compressed byte length written.
 */
export function insertChainSnapshot(
  scanId: number,
  snapshot: ChainSnapshot,
  db: HedgeDb = getDb(),
): number {
  const payload = gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"));
  db.run(
    `INSERT OR REPLACE INTO chain_snapshots
       (scan_id, ticker, captured_at, spot, expirations, payload, byte_len)
     VALUES (:scanId, :ticker, :capturedAt, :spot, :expirations, :payload, :byteLen)`,
    {
      scanId,
      ticker: snapshot.ticker,
      capturedAt: snapshot.capturedAt,
      spot: snapshot.spot,
      expirations: JSON.stringify(snapshot.expiries.map((e) => e.expiration)),
      payload,
      byteLen: payload.byteLength,
    },
  );
  return payload.byteLength;
}

/**
 * Read back a stored chain snapshot.
 *
 * @param scanId - Owning scan.
 * @param ticker - The underlying.
 * @param db - Database handle.
 * @returns The inflated snapshot, or `null` when absent or corrupt.
 */
export function getChainSnapshot(
  scanId: number,
  ticker: string,
  db: HedgeDb = getDb(),
): ChainSnapshot | null {
  const row = db.get<{ payload: Uint8Array }>(
    `SELECT payload FROM chain_snapshots WHERE scan_id = :scanId AND ticker = :ticker`,
    { scanId, ticker },
  );
  if (!row) return null;
  try {
    return JSON.parse(
      gunzipSync(Buffer.from(row.payload)).toString("utf8"),
    ) as ChainSnapshot;
  } catch (error) {
    logger.warn("hedge.db: corrupt chain snapshot", { scanId, ticker, error });
    return null;
  }
}

/* ── history ───────────────────────────────────────────────────────────────── */

/**
 * Upsert one day's observations.
 *
 * A same-day re-scan overwrites the row rather than appending, so the series
 * stays exactly one row per ticker per session no matter how often scans run.
 * A `null` field never overwrites a stored value: the morning scan may capture
 * skew that a degraded afternoon scan misses, and the day should keep it.
 *
 * @param rows - The observations to write.
 * @param db - Database handle.
 */
export function upsertHistory(
  rows: readonly HistoryRow[],
  db: HedgeDb = getDb(),
): void {
  if (rows.length === 0) return;
  const createdAt = nowIso();
  db.transaction(() => {
    for (const r of rows) {
      db.run(
        `INSERT INTO history
           (ticker, as_of, close, atm_iv, atm_iv_proxied, atm_iv_basis,
            realized_vol_20d, ewma_vol, vrp, put_skew_25d, call_put_spread,
            term_slope, source, created_at)
         VALUES
           (:ticker, :asOf, :close, :atmIv, :proxied, :basis,
            :rv, :ewmaVol, :vrp, :putSkew, :callPutSpread,
            :termSlope, :source, :createdAt)
         ON CONFLICT (ticker, as_of) DO UPDATE SET
           close            = COALESCE(excluded.close,            history.close),
           atm_iv           = COALESCE(excluded.atm_iv,           history.atm_iv),
           -- The flags MUST travel with the value they describe.
           --
           -- A backfill row carries (atm_iv = NULL, proxied = true, basis =
           -- 'realized_proxy'). The COALESCE above correctly KEEPS an existing
           -- real ATM IV — but stamping the flags unconditionally would then
           -- relabel that real observation as a proxy. countRealIvDays would stop
           -- counting it and the IV rank would never mature. Re-running a backfill
           -- after months of scans would have silently erased the real IV history
           -- of every ticker without a CBOE vol index.
           --
           -- So: adopt the incoming flags only when the incoming row actually
           -- brings an ATM IV. Otherwise keep whatever describes the value we are
           -- keeping.
           atm_iv_proxied   = CASE
                                WHEN excluded.atm_iv IS NULL
                                 AND history.atm_iv IS NOT NULL
                                THEN history.atm_iv_proxied
                                ELSE excluded.atm_iv_proxied
                              END,
           atm_iv_basis     = CASE
                                WHEN excluded.atm_iv IS NULL
                                 AND history.atm_iv IS NOT NULL
                                THEN history.atm_iv_basis
                                ELSE COALESCE(excluded.atm_iv_basis, history.atm_iv_basis)
                              END,
           realized_vol_20d = COALESCE(excluded.realized_vol_20d, history.realized_vol_20d),
           ewma_vol         = COALESCE(excluded.ewma_vol,         history.ewma_vol),
           vrp              = COALESCE(excluded.vrp,              history.vrp),
           put_skew_25d     = COALESCE(excluded.put_skew_25d,     history.put_skew_25d),
           call_put_spread  = COALESCE(excluded.call_put_spread,  history.call_put_spread),
           term_slope       = COALESCE(excluded.term_slope,       history.term_slope),
           source           = excluded.source,
           created_at       = excluded.created_at`,
        {
          ticker: r.ticker,
          asOf: r.asOf,
          close: r.close,
          atmIv: r.atmIv,
          proxied: r.atmIvProxied ? 1 : 0,
          basis: r.atmIvBasis,
          rv: r.realizedVol20d,
          ewmaVol: r.ewmaVol,
          vrp: r.vrp,
          putSkew: r.putSkew25d,
          callPutSpread: r.callPutSpread,
          termSlope: r.termSlope,
          source: r.source,
          createdAt,
        } satisfies Record<string, Param>,
      );
    }
  });
}

/** Map a raw history row into a {@link HistoryRow}. */
function mapHistory(r: Record<string, unknown>): HistoryRow {
  return {
    ticker: String(r.ticker),
    asOf: String(r.as_of),
    close: num(r.close),
    atmIv: num(r.atm_iv),
    atmIvProxied: toBool(r.atm_iv_proxied),
    atmIvBasis: (r.atm_iv_basis ?? null) as HistoryRow["atmIvBasis"],
    realizedVol20d: num(r.realized_vol_20d),
    ewmaVol: num(r.ewma_vol),
    vrp: num(r.vrp),
    putSkew25d: num(r.put_skew_25d),
    callPutSpread: num(r.call_put_spread),
    termSlope: num(r.term_slope),
    source: r.source === "backfill" ? "backfill" : "scan",
  };
}

/**
 * Read a ticker's trailing observation series, oldest first.
 *
 * @param ticker - The underlying.
 * @param lookbackDays - Maximum number of trailing rows.
 * @param db - Database handle.
 * @returns The series in ascending date order (what the rolling stats expect).
 */
export function getHistory(
  ticker: string,
  lookbackDays: number,
  db: HedgeDb = getDb(),
): HistoryRow[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM history WHERE ticker = :ticker ORDER BY as_of DESC LIMIT :limit`,
    { ticker, limit: lookbackDays },
  );
  return rows.map(mapHistory).reverse();
}

/**
 * Count a ticker's *real* (non-proxied) ATM IV observations.
 *
 * This is what gates the `proxied` badge: below `metrics.ivRankMinRealDays`,
 * IV rank is really a realized-volatility rank and must say so.
 *
 * @param ticker - The underlying.
 * @param db - Database handle.
 * @returns The number of days with a genuine ATM IV.
 */
export function countRealIvDays(ticker: string, db: HedgeDb = getDb()): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM history
      WHERE ticker = :ticker AND atm_iv IS NOT NULL AND atm_iv_proxied = 0`,
    { ticker },
  );
  return row?.n ?? 0;
}

/* ── metrics, pairs, setups ────────────────────────────────────────────────── */

/** Persist one scan's metrics rows. */
export function insertMetrics(
  scanId: number,
  rows: readonly TickerMetrics[],
  asOf: string,
  db: HedgeDb = getDb(),
): void {
  if (rows.length === 0) return;
  db.transaction(() => {
    for (const m of rows) {
      db.run(
        `INSERT OR REPLACE INTO metrics (
           scan_id, ticker, as_of, spot,
           risk_free_rate, dividend_yield, rates_fallback,
           atm_iv, atm_iv_30d, atm_iv_90d, atm_30d_bracketed,
           iv_rank, iv_percentile, iv_rank_proxied, iv_history_days,
           put_skew_25d, put_skew_z, call_put_spread, call_put_spread_z,
           skew_25d_bracketed, term_slope, term_slope_z, term_inverted, front_dte,
           ewma_vol, vrp, vrp_z,
           realized_vol_20d, pct_vs_200dma, pct_from_52w_high, pct_from_52w_low, rsi14,
           corr_spy_60d, earnings_date, earnings_in_front_window, ex_dividend_date,
           contracts_total, contracts_excluded, parity_violations, data_quality
         ) VALUES (
           :scanId, :ticker, :asOf, :spot,
           :r, :q, :ratesFallback,
           :atmIv, :atmIv30, :atmIv90, :atm30Bracketed,
           :ivRank, :ivPercentile, :ivRankProxied, :ivHistoryDays,
           :putSkew, :putSkewZ, :callPutSpread, :callPutSpreadZ,
           :skewBracketed, :termSlope, :termSlopeZ, :termInverted, :frontDte,
           :ewmaVol, :vrp, :vrpZ,
           :rv20, :pct200, :pct52h, :pct52l, :rsi,
           :corr, :earnings, :earningsIn, :exDiv,
           :cTotal, :cExcluded, :parity, :quality
         )`,
        {
          scanId,
          ticker: m.ticker,
          asOf,
          spot: m.spot,
          r: m.riskFreeRate,
          q: m.dividendYield,
          ratesFallback: m.ratesFallback ? 1 : 0,
          // Stored in vol points, matching `history.atm_iv`.
          atmIv: m.atmIv30 !== null ? m.atmIv30 * 100 : null,
          atmIv30: m.atmIv30 !== null ? m.atmIv30 * 100 : null,
          atmIv90: m.atmIv90 !== null ? m.atmIv90 * 100 : null,
          atm30Bracketed: m.atm30Bracketed ? 1 : 0,
          ivRank: m.ivRank,
          ivPercentile: m.ivPercentile,
          ivRankProxied: m.ivRankProxied ? 1 : 0,
          ivHistoryDays: m.ivHistoryDays,
          putSkew: m.putSkew25d,
          putSkewZ: m.putSkewZ,
          callPutSpread: m.callPutSpread,
          callPutSpreadZ: m.callPutSpreadZ,
          skewBracketed: m.skew25dBracketed ? 1 : 0,
          termSlope: m.termSlope,
          termSlopeZ: m.termSlopeZ,
          termInverted: m.termInverted ? 1 : 0,
          frontDte: m.frontDte,
          ewmaVol: m.ewmaVol,
          vrp: m.vrp,
          vrpZ: m.vrpZ,
          rv20: m.realizedVol20d,
          pct200: m.pctVs200dma,
          pct52h: m.pctFrom52wHigh,
          pct52l: m.pctFrom52wLow,
          rsi: m.rsi14,
          corr: m.corrSpy60d,
          earnings: m.earningsDate,
          earningsIn: m.earningsInFrontWindow ? 1 : 0,
          exDiv: m.exDividendDate,
          cTotal: m.contractsTotal,
          cExcluded: m.contractsExcluded,
          parity: m.parityViolations,
          quality: m.dataQuality,
        } satisfies Record<string, Param>,
      );
    }
  });
}

/** Read a scan's metrics rows as the raw JSON the API serves. */
export function getMetricsForScan(
  scanId: number,
  db: HedgeDb = getDb(),
): Record<string, unknown>[] {
  return db.all<Record<string, unknown>>(
    "SELECT * FROM metrics WHERE scan_id = :scanId ORDER BY ticker",
    { scanId },
  );
}

/** Persist one scan's pair metrics. */
export function insertPairMetrics(
  scanId: number,
  pairs: readonly PairMetric[],
  db: HedgeDb = getDb(),
): void {
  if (pairs.length === 0) return;
  db.transaction(() => {
    for (const p of pairs) {
      db.run(
        `INSERT OR REPLACE INTO pair_metrics
           (scan_id, pair_id, ratio, mean, sd, zscore, ou_lambda, half_life,
            mean_reversion, cointegration)
         VALUES
           (:scanId, :pairId, :ratio, :mean, :sd, :z, :lambda, :halfLife,
            :meanReversion, :cointegration)`,
        {
          scanId,
          pairId: p.pairId,
          ratio: p.ratio,
          mean: p.mean,
          sd: p.sd,
          z: p.zScore,
          lambda: p.ouLambda,
          halfLife: p.halfLife,
          meanReversion: p.meanReversion,
          cointegration: p.cointegration,
        } satisfies Record<string, Param>,
      );
    }
  });
}

/** Persist one scan's ranked setups. */
export function insertSetups(
  scanId: number,
  ranked: Record<string, readonly Setup[]>,
  db: HedgeDb = getDb(),
): void {
  db.transaction(() => {
    for (const [scanner, setups] of Object.entries(ranked)) {
      setups.forEach((s, index) => {
        db.run(
          `INSERT OR REPLACE INTO setups
             (scan_id, scanner, ticker, rank, score, proxied, signal_hash, payload)
           VALUES
             (:scanId, :scanner, :ticker, :rank, :score, :proxied, :hash, :payload)`,
          {
            scanId,
            scanner,
            ticker: s.ticker,
            rank: index + 1,
            score: s.score,
            proxied: s.proxied ? 1 : 0,
            hash: s.signalHash,
            payload: JSON.stringify(s),
          } satisfies Record<string, Param>,
        );
      });
    }
  });
}

/** Read a scan's setups for one scanner, best-first. */
export function getSetups(
  scanId: number,
  scanner: string,
  db: HedgeDb = getDb(),
): Setup[] {
  const rows = db.all<{ payload: string }>(
    `SELECT payload FROM setups
      WHERE scan_id = :scanId AND scanner = :scanner
      ORDER BY rank ASC`,
    { scanId, scanner },
  );
  const out: Setup[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.payload) as Setup);
    } catch {
      logger.warn("hedge.db: corrupt setup payload", { scanId, scanner });
    }
  }
  return out;
}

/** Read a scan's pair metrics. */
export function getPairMetrics(
  scanId: number,
  db: HedgeDb = getDb(),
): Record<string, unknown>[] {
  return db.all<Record<string, unknown>>(
    "SELECT * FROM pair_metrics WHERE scan_id = :scanId ORDER BY pair_id",
    { scanId },
  );
}

/** A summary of how much history has accumulated, for the health endpoint. */
export interface HistoryDepth {
  /** Distinct tickers with at least one observation. */
  tickers: number;
  /** Distinct calendar days observed. */
  days: number;
  /** Median count of real (non-proxied) IV observations per ticker. */
  medianRealIvDays: number;
  /** Oldest and newest observation dates, or `null` on an empty database. */
  firstAsOf: string | null;
  lastAsOf: string | null;
}

/**
 * Summarize the accumulated history.
 *
 * Exists so the health endpoint can answer the one question that matters on a
 * young install: is IV rank real yet, or still a realized-vol proxy?
 *
 * @param db - Database handle.
 * @returns The depth summary.
 */
export function getHistoryDepth(db: HedgeDb = getDb()): HistoryDepth {
  const totals = db.get<{
    tickers: number;
    days: number;
    first: string | null;
    last: string | null;
  }>(
    `SELECT COUNT(DISTINCT ticker) AS tickers,
            COUNT(DISTINCT as_of)  AS days,
            MIN(as_of)             AS first,
            MAX(as_of)             AS last
       FROM history`,
  );

  const perTicker = db.all<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM history
      WHERE atm_iv IS NOT NULL AND atm_iv_proxied = 0
      GROUP BY ticker
      ORDER BY n`,
  );
  const mid = Math.floor(perTicker.length / 2);
  const medianRealIvDays =
    perTicker.length === 0 ? 0 : (perTicker[mid]?.n ?? 0);

  return {
    tickers: totals?.tickers ?? 0,
    days: totals?.days ?? 0,
    medianRealIvDays,
    firstAsOf: totals?.first ?? null,
    lastAsOf: totals?.last ?? null,
  };
}

/**
 * A ticker's chain-measured ATM IV by date.
 *
 * Only rows whose basis is `chain` — a real scan of a real option chain. A
 * backfilled or proxied row must never be used to calibrate a backfill against
 * itself, which would be circular.
 *
 * @param ticker - The underlying.
 * @param db - Database handle.
 * @returns A map of `YYYY-MM-DD` to ATM IV in vol points.
 */
export function getChainAtmIvByDate(
  ticker: string,
  db: HedgeDb = getDb(),
): Map<string, number> {
  const rows = db.all<{ as_of: string; atm_iv: number }>(
    `SELECT as_of, atm_iv FROM history
      WHERE ticker = :ticker AND atm_iv IS NOT NULL AND atm_iv_basis = 'chain'`,
    { ticker },
  );
  return new Map(rows.map((r) => [String(r.as_of), Number(r.atm_iv)]));
}
