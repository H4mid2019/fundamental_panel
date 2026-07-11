/**
 * SQLite connection for HedgeScope.
 *
 * Uses Node's built-in `node:sqlite`, not `better-sqlite3`. Both drivers are
 * synchronous, so the choice costs nothing on that axis — but `better-sqlite3`
 * is a native addon, which would mean a C toolchain (`python3`/`make`/`g++`) in
 * the Docker build stage and an arm64 prebuild to gamble on at every Node
 * upgrade. The built-in has zero of that. It is still flagged experimental
 * (hence the boot-time `ExperimentalWarning`), and its API is frozen to
 * `DatabaseSync`/`StatementSync`, which is all we need.
 *
 * Everything else in this app is stateless fetch-and-cache; this file is the
 * one place that owns durable state. Losing the file loses the accumulated IV
 * history, so the DB lives on a named Docker volume — see the README.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { env } from "../../env";
import { logger } from "../../logger";

import { migrate } from "./migrations";

/**
 * A prepared-statement row. `node:sqlite` returns null-prototype objects whose
 * values are limited to SQLite's storage classes.
 */
export type Row = Record<string, string | number | bigint | Uint8Array | null>;

/** Values bindable to a statement parameter. */
export type Param = string | number | bigint | Uint8Array | null;

/** The narrow slice of `DatabaseSync` the repository layer depends on. */
export interface HedgeDb {
  /** Run a statement, discarding any rows. */
  run(sql: string, params?: Record<string, Param>): void;
  /** Run a query and return every row. */
  all<T = Row>(sql: string, params?: Record<string, Param>): T[];
  /** Run a query and return the first row, or `null`. */
  get<T = Row>(sql: string, params?: Record<string, Param>): T | null;
  /** Execute one or more statements with no parameters (DDL, PRAGMA). */
  exec(sql: string): void;
  /** Run `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): T;
  /** Close the underlying handle. */
  close(): void;
}

/** Wrap a `DatabaseSync` handle in the {@link HedgeDb} interface. */
function wrap(db: DatabaseSync): HedgeDb {
  return {
    run(sql, params) {
      db.prepare(sql).run(params ?? {});
    },
    all<T>(sql: string, params?: Record<string, Param>): T[] {
      return db.prepare(sql).all(params ?? {}) as T[];
    },
    get<T>(sql: string, params?: Record<string, Param>): T | null {
      return (db.prepare(sql).get(params ?? {}) as T | undefined) ?? null;
    },
    exec(sql) {
      db.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}

/**
 * Open a SQLite database at `path`, apply pragmas and run migrations.
 *
 * @param path - File path, or `:memory:` for an ephemeral database.
 * @returns A migrated, ready-to-use handle.
 */
export function openDb(path: string): HedgeDb {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });

  const db = wrap(new DatabaseSync(path));
  // WAL lets the dashboard read while a scan writes. `synchronous = NORMAL` is
  // the standard WAL pairing: durable across process crashes, and a host crash
  // can at worst lose the last scan — which the next scan simply recomputes.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  // A scan writing while the dashboard reads should wait, not fail instantly.
  db.exec("PRAGMA busy_timeout = 5000");

  migrate(db);
  return db;
}

let instance: HedgeDb | null = null;

/**
 * The process-wide database handle, opened and migrated on first use.
 *
 * @returns The shared {@link HedgeDb}.
 */
export function getDb(): HedgeDb {
  if (instance) return instance;
  const path = env.HEDGE_DB_PATH;
  instance = openDb(path);
  logger.info("hedge.db.open", { path });
  return instance;
}

/** Close and forget the shared handle. Test-only. */
export function closeDb(): void {
  instance?.close();
  instance = null;
}
