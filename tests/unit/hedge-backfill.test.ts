/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/chart/types";
import {
  overlayVolIndex,
  rebuildHistory,
  VOL_INDEX,
} from "@/lib/hedge/backfill";
import { ewmaVolatility, logReturns } from "@/lib/hedge/math/stats";

const config = { ewmaLambda: 0.94, realizedVolWindowDays: 20 };

/** Deterministic daily candles ending today. */
function candles(count: number, vol = 0.01): Candle[] {
  let state = 17;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state + 1) / 4294967297 - 0.5;
  };
  const out: Candle[] = [];
  let price = 100;
  const start = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
  for (let i = 0; i < count; i += 1) {
    price *= Math.exp(vol * rand() * 2);
    out.push({
      time: start + i * 86_400,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: null,
    });
  }
  return out;
}

describe("VOL_INDEX", () => {
  // Verified live: Yahoo carries usable history for exactly these five. The
  // single-name indices (^VXAPL, ^VXGOG, ...) return one bar — CBOE
  // discontinued them — so they are deliberately absent rather than optimistic.
  it("maps only the underlyings whose CBOE index actually has history", () => {
    expect(VOL_INDEX).toEqual({
      SPY: "^VIX",
      QQQ: "^VXN",
      DIA: "^VXD",
      GLD: "^GVZ",
      USO: "^OVX",
    });
  });
});

describe("rebuildHistory", () => {
  it("reconstructs one row per session with realized vol and EWMA", () => {
    const rows = rebuildHistory("SPY", candles(300), 200, config);

    expect(rows.length).toBeGreaterThan(150);
    for (const r of rows) {
      expect(r.ticker).toBe("SPY");
      expect(r.source).toBe("backfill");
      expect(r.realizedVol20d).not.toBeNull();
      expect(r.ewmaVol).not.toBeNull();
      expect(r.close).toBeGreaterThan(0);
    }
    // Ascending, one row per day, no duplicates.
    const dates = rows.map((r) => r.asOf);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  // Without a chain there IS no implied vol on that day, and a realized-vol
  // stand-in must never be allowed to mature the IV rank by pretending otherwise.
  it("marks every rebuilt row as an explicitly proxied observation", () => {
    const rows = rebuildHistory("AAPL", candles(300), 200, config);
    for (const r of rows) {
      expect(r.atmIv).toBeNull();
      expect(r.atmIvProxied).toBe(true);
      expect(r.atmIvBasis).toBe("realized_proxy");
      expect(r.vrp).toBeNull();
    }
  });

  // THE trap of any backfill. A series that peeked at the future produces an IV
  // rank that always looks prescient, and a backtest that always wins.
  it("never looks ahead: each row uses only candles up to that day", () => {
    const bars = candles(200);
    const rows = rebuildHistory("SPY", bars, 100, config);

    const row = rows[rows.length - 1];
    expect(row).toBeDefined();
    if (!row) return;

    // Recompute the last row from the full series and it must match. Then
    // recompute it from a series TRUNCATED at that day — also a match, which
    // proves nothing after it was used.
    const upToRowIndex = bars.findIndex(
      (b) => new Date(b.time * 1000).toISOString().slice(0, 10) === row.asOf,
    );
    expect(upToRowIndex).toBeGreaterThan(0);

    const truncated = bars.slice(0, upToRowIndex + 1);
    const expected = ewmaVolatility(
      logReturns(truncated.map((c) => c.close)),
      config.ewmaLambda,
    );
    expect(row.ewmaVol).toBeCloseTo(expected ?? 0, 10);
  });

  it("declines to build rows from too few candles", () => {
    expect(rebuildHistory("SPY", candles(30), 200, config)).toEqual([]);
    expect(rebuildHistory("SPY", [], 200, config)).toEqual([]);
  });
});

describe("overlayVolIndex", () => {
  const base = rebuildHistory("SPY", candles(300), 200, config);

  // A CBOE implied-vol index IS implied vol. It is measured by CBOE and rebased
  // onto our units — but it is not a realized-vol stand-in, so it legitimately
  // matures the IV rank, and `countRealIvDays` will count it.
  it("fills in REAL implied vol and un-proxies those rows", () => {
    const index = candles(300, 0).map((c, i) => ({
      ...c,
      close: 15 + (i % 10),
    }));
    const rows = overlayVolIndex(base, index, 1.2);

    const filled = rows.filter((r) => r.atmIv !== null);
    expect(filled.length).toBeGreaterThan(100);

    for (const r of filled) {
      expect(r.atmIvProxied).toBe(false);
      expect(r.atmIvBasis).toBe("vol_index");
      // VRP becomes computable historically once real implied vol exists.
      expect(r.vrp).toBeCloseTo((r.atmIv ?? 0) - (r.ewmaVol ?? 0), 10);
    }
  });

  it("applies the calibration ratio, which puts the index on our units", () => {
    const index = base.map((r) => ({
      time: Math.floor(Date.parse(`${r.asOf}T00:00:00Z`) / 1000),
      open: 20,
      high: 20,
      low: 20,
      close: 20,
      volume: null,
    }));

    const rows = overlayVolIndex(base, index, 0.9);
    const filled = rows.find((r) => r.atmIv !== null);
    expect(filled?.atmIv).toBeCloseTo(18, 10); // 20 x 0.9
  });

  // The calibration only fixes the LEVEL. A rank cares about shape, so the
  // relative ordering of the series must survive untouched.
  it("preserves the shape of the series, which is all a rank reads", () => {
    const index = base.map((r, i) => ({
      time: Math.floor(Date.parse(`${r.asOf}T00:00:00Z`) / 1000),
      open: 0,
      high: 0,
      low: 0,
      close: 12 + Math.sin(i / 8) * 5,
      volume: null,
    }));

    const a = overlayVolIndex(base, index, 1).map((r) => r.atmIv ?? 0);
    const b = overlayVolIndex(base, index, 1.4).map((r) => r.atmIv ?? 0);

    // Same ordering, different level.
    for (let i = 1; i < a.length; i += 1) {
      const aUp = (a[i] ?? 0) > (a[i - 1] ?? 0);
      const bUp = (b[i] ?? 0) > (b[i - 1] ?? 0);
      expect(aUp).toBe(bUp);
    }
  });

  it("leaves rows with no index value untouched", () => {
    const rows = overlayVolIndex(base, [], 1.2);
    expect(rows.every((r) => r.atmIv === null)).toBe(true);
    expect(rows.every((r) => r.atmIvProxied)).toBe(true);
  });
});
