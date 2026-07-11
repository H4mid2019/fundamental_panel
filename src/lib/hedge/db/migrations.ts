/**
 * Versioned, forward-only schema migrations.
 *
 * Each entry is applied exactly once, in order, inside a transaction, and its
 * version is recorded in `schema_migrations`. Never edit a shipped migration —
 * append a new one, or a deployed database and a fresh one will diverge.
 */

import { logger } from "../../logger";

import type { HedgeDb } from "./client";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * The core split, which is the one thing worth understanding here:
 *
 * - `history` is the append-only *observation* series — one row per ticker per
 *   day. It is what IV rank and every z-score are computed against, and it is
 *   the only table whose loss is unrecoverable. The backfill script writes it
 *   directly, without needing a scan.
 * - `metrics` is the *derived* per-scan snapshot (ranks, z-scores, flags). It
 *   can always be recomputed from `history` + `chain_snapshots`.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      -- One row per scan run. The trigger column distinguishes cron from a
      -- manual run or a backfill, so a partial/failed scan can be reasoned
      -- about after the fact.
      CREATE TABLE scans (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at     TEXT    NOT NULL,
        finished_at    TEXT,
        trigger        TEXT    NOT NULL CHECK (trigger IN ('cron','manual','backfill')),
        status         TEXT    NOT NULL CHECK (status IN ('running','ok','partial','failed')),
        tickers_ok     INTEGER NOT NULL DEFAULT 0,
        tickers_failed INTEGER NOT NULL DEFAULT 0,
        error          TEXT
      );
      CREATE INDEX idx_scans_started ON scans (started_at DESC);

      -- Raw option chains, gzipped. Kept verbatim (including contracts the
      -- quality filter later rejects) so a metric can be recomputed after a bug
      -- fix without re-fetching from Yahoo. Parquet buys nothing at this scale.
      CREATE TABLE chain_snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id     INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        ticker      TEXT    NOT NULL,
        captured_at TEXT    NOT NULL,
        spot        REAL,
        expirations TEXT    NOT NULL,  -- JSON array of the ISO dates captured
        payload     BLOB    NOT NULL,  -- gzip(JSON) of the full ChainSnapshot
        byte_len    INTEGER NOT NULL,  -- compressed size, for storage budgeting
        UNIQUE (scan_id, ticker)
      );
      CREATE INDEX idx_chain_ticker_time ON chain_snapshots (ticker, captured_at DESC);

      -- The append-only daily observation series. IV rank and every z-score
      -- read from here. atm_iv_proxied records that the day's IV is really a
      -- realized-vol stand-in, so the API and UI can say so out loud.
      CREATE TABLE history (
        ticker            TEXT    NOT NULL,
        as_of             TEXT    NOT NULL,  -- YYYY-MM-DD
        close             REAL,
        atm_iv            REAL,
        atm_iv_proxied    INTEGER NOT NULL DEFAULT 0,
        realized_vol_20d  REAL,
        put_skew_25d      REAL,
        call_put_spread   REAL,
        term_slope        REAL,
        source            TEXT    NOT NULL CHECK (source IN ('scan','backfill')),
        created_at        TEXT    NOT NULL,
        PRIMARY KEY (ticker, as_of)
      );
      CREATE INDEX idx_history_ticker_asof ON history (ticker, as_of DESC);

      -- Derived per-scan metrics. Recomputable; safe to drop and rebuild.
      CREATE TABLE metrics (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id                  INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        ticker                   TEXT    NOT NULL,
        as_of                    TEXT    NOT NULL,
        spot                     REAL,
        atm_iv                   REAL,
        atm_iv_source            TEXT,     -- 'solved' | 'yahoo' | 'proxy'
        iv_rank                  REAL,
        iv_percentile            REAL,
        iv_rank_proxied          INTEGER NOT NULL DEFAULT 0,
        iv_history_days          INTEGER NOT NULL DEFAULT 0,
        put_skew_25d             REAL,
        put_skew_z               REAL,
        call_put_spread          REAL,
        call_put_spread_z        REAL,
        term_slope               REAL,
        term_slope_z             REAL,
        term_inverted            INTEGER NOT NULL DEFAULT 0,
        front_dte                INTEGER,
        realized_vol_20d         REAL,
        pct_vs_200dma            REAL,
        pct_from_52w_high        REAL,
        pct_from_52w_low         REAL,
        rsi14                    REAL,
        corr_spy_60d             REAL,
        corr_regime              TEXT,     -- 'normal' | 'break_high' | 'break_low'
        earnings_date            TEXT,
        earnings_in_front_window INTEGER NOT NULL DEFAULT 0,
        ex_dividend_date         TEXT,
        UNIQUE (scan_id, ticker)
      );
      CREATE INDEX idx_metrics_ticker ON metrics (ticker, as_of DESC);

      -- Per-scan ratio-pair z-scores. The sparkline *series* is recomputed from
      -- candles on request, so it has full history from day one; only the
      -- point-in-time z-score is persisted, for alert dedupe.
      CREATE TABLE pair_metrics (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        pair_id TEXT    NOT NULL,
        ratio   REAL,
        mean    REAL,
        sd      REAL,
        zscore  REAL,
        UNIQUE (scan_id, pair_id)
      );

      -- Ranked scanner output. The payload column is the concrete setup (legs,
      -- strikes, expiry, cost, payoff); signal_hash keys the AI cache.
      CREATE TABLE setups (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id     INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        scanner     TEXT    NOT NULL,
        ticker      TEXT    NOT NULL,
        rank        INTEGER NOT NULL,
        score       REAL    NOT NULL,
        proxied     INTEGER NOT NULL DEFAULT 0,
        signal_hash TEXT    NOT NULL,
        payload     TEXT    NOT NULL,  -- JSON
        UNIQUE (scan_id, scanner, ticker)
      );
      CREATE INDEX idx_setups_scan_scanner ON setups (scan_id, scanner, rank);

      -- Fired alerts. dedupe_key + created_at implement the cooldown.
      CREATE TABLE alerts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at     TEXT    NOT NULL,
        scan_id        INTEGER REFERENCES scans(id) ON DELETE SET NULL,
        ticker         TEXT    NOT NULL,
        type           TEXT    NOT NULL,
        severity       TEXT    NOT NULL CHECK (severity IN ('info','warn','critical')),
        title          TEXT    NOT NULL,
        detail         TEXT    NOT NULL,
        proxied        INTEGER NOT NULL DEFAULT 0,
        dedupe_key     TEXT    NOT NULL,
        delivered_slack INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_alerts_created ON alerts (created_at DESC);
      CREATE INDEX idx_alerts_dedupe ON alerts (dedupe_key, created_at DESC);

      -- AI interpretations, keyed by (ticker, signal_hash) so an unchanged
      -- signal never re-bills the model on a re-render.
      CREATE TABLE ai_cache (
        ticker      TEXT NOT NULL,
        signal_hash TEXT NOT NULL,
        model       TEXT NOT NULL,
        payload     TEXT NOT NULL,  -- JSON
        fallback    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (ticker, signal_hash)
      );
    `,
  },
];

/** The schema version this build expects. */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);

/**
 * Read the applied schema version.
 *
 * @param db - An open database handle.
 * @returns The highest applied migration version, or `0` on a fresh database.
 */
export function currentVersion(db: HedgeDb): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );
  const row = db.get<{ version: number | null }>(
    "SELECT MAX(version) AS version FROM schema_migrations",
  );
  return row?.version ?? 0;
}

/**
 * Apply every migration newer than the database's current version.
 *
 * Idempotent: running it against an up-to-date database is a no-op, so it is
 * safe to call on every boot.
 *
 * @param db - An open database handle.
 * @returns The version the database is at afterwards.
 */
export function migrate(db: HedgeDb): number {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) return from;

  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.run(
        `INSERT INTO schema_migrations (version, name, applied_at)
         VALUES (:version, :name, :appliedAt)`,
        {
          version: m.version,
          name: m.name,
          appliedAt: new Date().toISOString(),
        },
      );
    });
    logger.info("hedge.db.migrated", { version: m.version, name: m.name });
  }
  return LATEST_VERSION;
}
