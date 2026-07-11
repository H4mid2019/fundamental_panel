/**
 * @vitest-environment node
 *
 * The suite default is jsdom, which cannot resolve `node:sqlite`. The database
 * layer is server-only by construction, so it is tested in the runtime it
 * actually runs in.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type HedgeDb } from "@/lib/hedge/db/client";
import {
  currentVersion,
  LATEST_VERSION,
  migrate,
} from "@/lib/hedge/db/migrations";
import {
  countRealIvDays,
  finishScan,
  getChainSnapshot,
  getHistory,
  getLatestScan,
  insertChainSnapshot,
  listScans,
  startScan,
  upsertHistory,
  type HistoryRow,
} from "@/lib/hedge/db/repo";
import { fixtureChainSnapshot } from "@/lib/hedge/fixtures";

let db: HedgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

const history = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  ticker: "SPY",
  asOf: "2026-07-10",
  close: 750,
  // Vol points, matching the constant-maturity 30d ATM IV the engine writes.
  atmIv: 18,
  atmIvProxied: false,
  atmIvBasis: "chain",
  realizedVol20d: 14,
  ewmaVol: 13.5,
  vrp: 4.5,
  putSkew25d: 3,
  callPutSpread: -2,
  termSlope: 1,
  source: "scan",
  ...over,
});

describe("migrations", () => {
  it("brings a fresh database to the latest version", () => {
    expect(currentVersion(db)).toBe(LATEST_VERSION);
    expect(LATEST_VERSION).toBeGreaterThan(0);
  });

  it("is idempotent — re-running applies nothing", () => {
    expect(migrate(db)).toBe(LATEST_VERSION);
    expect(migrate(db)).toBe(LATEST_VERSION);
    const rows = db.all<{ version: number }>(
      "SELECT version FROM schema_migrations",
    );
    expect(rows).toHaveLength(LATEST_VERSION);
  });

  it("creates every table the scan pipeline writes to", () => {
    const names = db
      .all<{
        name: string;
      }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name);
    for (const table of [
      "scans",
      "chain_snapshots",
      "history",
      "metrics",
      "pair_metrics",
      "setups",
      "alerts",
      "ai_cache",
      "schema_migrations",
    ]) {
      expect(names).toContain(table);
    }
  });

  it("enforces the scan status and trigger check constraints", () => {
    expect(() =>
      db.run(
        `INSERT INTO scans (started_at, trigger, status)
         VALUES ('2026-07-11T00:00:00Z', 'nonsense', 'running')`,
      ),
    ).toThrow();
  });
});

describe("scans", () => {
  it("opens a running scan and closes it out", () => {
    const id = startScan("manual", db);
    expect(id).toBeGreaterThan(0);

    // A scan in flight is not the "latest completed" scan.
    expect(getLatestScan(db)).toBeNull();

    finishScan(id, { status: "partial", tickersOk: 58, tickersFailed: 2 }, db);
    const latest = getLatestScan(db);
    expect(latest?.id).toBe(id);
    expect(latest?.status).toBe("partial");
    expect(latest?.tickersOk).toBe(58);
    expect(latest?.tickersFailed).toBe(2);
    expect(latest?.trigger).toBe("manual");
    expect(latest?.finishedAt).not.toBeNull();
  });

  it("records a failure reason", () => {
    const id = startScan("cron", db);
    finishScan(
      id,
      { status: "failed", tickersOk: 0, tickersFailed: 3, error: "boom" },
      db,
    );
    expect(getLatestScan(db)?.error).toBe("boom");
  });

  it("lists scans newest first", () => {
    for (const t of ["cron", "manual", "backfill"] as const) {
      finishScan(
        startScan(t, db),
        { status: "ok", tickersOk: 1, tickersFailed: 0 },
        db,
      );
    }
    expect(listScans(10, db)).toHaveLength(3);
  });
});

describe("chain snapshots", () => {
  it("round-trips a gzipped snapshot", () => {
    const scanId = startScan("manual", db);
    const snapshot = fixtureChainSnapshot(
      "SPY",
      new Date("2026-07-11T14:00:00Z"),
    );

    const bytes = insertChainSnapshot(scanId, snapshot, db);
    expect(bytes).toBeGreaterThan(0);

    const read = getChainSnapshot(scanId, "SPY", db);
    expect(read).toEqual(snapshot);
  });

  it("compresses substantially — chains are highly repetitive JSON", () => {
    const scanId = startScan("manual", db);
    const snapshot = fixtureChainSnapshot(
      "AAPL",
      new Date("2026-07-11T14:00:00Z"),
    );
    const raw = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    const bytes = insertChainSnapshot(scanId, snapshot, db);
    expect(bytes).toBeLessThan(raw / 4);
  });

  it("returns null for a snapshot that was never stored", () => {
    expect(getChainSnapshot(999, "NOPE", db)).toBeNull();
  });

  it("overwrites on a re-scan of the same (scan, ticker)", () => {
    const scanId = startScan("manual", db);
    const now = new Date("2026-07-11T14:00:00Z");
    insertChainSnapshot(scanId, fixtureChainSnapshot("SPY", now), db);
    insertChainSnapshot(scanId, fixtureChainSnapshot("SPY", now), db);
    const rows = db.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM chain_snapshots WHERE ticker = 'SPY'",
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe("history", () => {
  it("writes and reads back a series in ascending date order", () => {
    upsertHistory(
      [
        history({ asOf: "2026-07-08", atmIv: 0.2 }),
        history({ asOf: "2026-07-10", atmIv: 0.18 }),
        history({ asOf: "2026-07-09", atmIv: 0.19 }),
      ],
      db,
    );

    const rows = getHistory("SPY", 252, db);
    expect(rows.map((r) => r.asOf)).toEqual([
      "2026-07-08",
      "2026-07-09",
      "2026-07-10",
    ]);
    expect(rows.map((r) => r.atmIv)).toEqual([0.2, 0.19, 0.18]);
  });

  it("keeps one row per ticker per day across re-scans", () => {
    upsertHistory([history({ atmIv: 0.18 })], db);
    upsertHistory([history({ atmIv: 0.21 })], db);

    const rows = getHistory("SPY", 252, db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.atmIv).toBe(0.21);
  });

  // The afternoon scan may degrade and lose skew that the morning scan captured.
  // A null must not erase the day's good data.
  it("does not let a null overwrite a value already recorded that day", () => {
    upsertHistory([history({ putSkew25d: 0.05, close: 750 })], db);
    upsertHistory([history({ putSkew25d: null, close: null })], db);

    const rows = getHistory("SPY", 252, db);
    expect(rows[0]?.putSkew25d).toBe(0.05);
    expect(rows[0]?.close).toBe(750);
  });

  it("respects the lookback limit, keeping the most recent rows", () => {
    const rows: HistoryRow[] = [];
    for (let d = 1; d <= 30; d += 1) {
      rows.push(
        history({
          asOf: `2026-06-${String(d).padStart(2, "0")}`,
          atmIv: d / 100,
        }),
      );
    }
    upsertHistory(rows, db);

    const recent = getHistory("SPY", 5, db);
    expect(recent).toHaveLength(5);
    expect(recent[0]?.asOf).toBe("2026-06-26");
    expect(recent[4]?.asOf).toBe("2026-06-30");
  });

  it("separates tickers", () => {
    upsertHistory(
      [history({ ticker: "SPY" }), history({ ticker: "QQQ", atmIv: 0.25 })],
      db,
    );
    expect(getHistory("QQQ", 252, db)[0]?.atmIv).toBe(0.25);
    expect(getHistory("IWM", 252, db)).toEqual([]);
  });

  it("is a no-op on an empty batch", () => {
    expect(() => upsertHistory([], db)).not.toThrow();
  });
});

describe("countRealIvDays", () => {
  // This is what gates the `proxied` badge: only genuine ATM IV observations
  // count, so a backfilled realized-vol proxy must never mature the IV rank.
  it("counts only non-proxied observations with an actual IV", () => {
    upsertHistory(
      [
        history({ asOf: "2026-07-06", atmIv: 0.2, atmIvProxied: false }),
        history({ asOf: "2026-07-07", atmIv: 0.19, atmIvProxied: false }),
        history({ asOf: "2026-07-08", atmIv: 0.22, atmIvProxied: true }),
        history({ asOf: "2026-07-09", atmIv: null, atmIvProxied: false }),
      ],
      db,
    );
    expect(countRealIvDays("SPY", db)).toBe(2);
    expect(countRealIvDays("NOPE", db)).toBe(0);
  });
});

describe("transactions", () => {
  it("rolls back a failed batch, leaving no partial writes", () => {
    expect(() =>
      db.transaction(() => {
        db.run(
          `INSERT INTO scans (started_at, trigger, status)
           VALUES ('2026-07-11T00:00:00Z', 'cron', 'running')`,
        );
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(listScans(10, db)).toHaveLength(0);
  });
});
