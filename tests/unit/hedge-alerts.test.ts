/**
 * @vitest-environment node
 *
 * The alerts engine writes to SQLite (the cooldown is a query, not a variable),
 * so it is tested in the runtime it runs in.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseHedgeConfig } from "@/lib/hedge/config";
import {
  buildAlerts,
  fireAlerts,
  listAlerts,
  type AlertDraft,
} from "@/lib/hedge/alerts/engine";
import { openDb, type HedgeDb } from "@/lib/hedge/db/client";
import { startScan } from "@/lib/hedge/db/repo";
import type { TickerMetrics } from "@/lib/hedge/metrics/engine";
import type { PairMetric } from "@/lib/hedge/metrics/pairs";
import type { Setup } from "@/lib/hedge/scanners";

const config = parseHedgeConfig(
  readFileSync("hedge.config.yaml", "utf8").replace(/\r\n/g, "\n"),
  "hedge.config.yaml",
);

let db: HedgeDb;
let scanId: number;

beforeEach(() => {
  db = openDb(":memory:");
  scanId = startScan("manual", db);
});

afterEach(() => {
  db.close();
});

const metrics = (over: Partial<TickerMetrics> = {}): TickerMetrics => ({
  ticker: "SPY",
  spot: 500,
  riskFreeRate: 0.037,
  dividendYield: 0.01,
  ratesFallback: false,
  atmIv30: 0.15,
  atmIv90: 0.17,
  atm30Bracketed: true,
  ivRank: 30,
  ivPercentile: 30,
  ivRankProxied: false,
  ivHistoryDays: 100,
  putSkew25d: 2,
  putSkewZ: 0.5,
  callPutSpread: -2,
  callPutSpreadZ: 0.1,
  skew25dBracketed: true,
  put25Strike: 480,
  call25Strike: 520,
  termSlope: 2,
  termSlopeZ: 0.2,
  termInverted: false,
  frontDte: 14,
  ewmaVol: 13,
  realizedVol20d: 14,
  vrp: 2,
  vrpZ: 0.3,
  vrpState: "rich",
  pctVs200dma: 5,
  pctFrom52wHigh: -3,
  pctFrom52wLow: 20,
  rsi14: 55,
  corrSpy60d: 1,
  earningsDate: null,
  exDividendDate: null,
  earningsInFrontWindow: false,
  contractsTotal: 400,
  contractsExcluded: 20,
  parityViolations: 18,
  dataQuality: "good",
  ...over,
});

const pair = (over: Partial<PairMetric> = {}): PairMetric => ({
  pairId: "gld-gdx",
  label: "Gold vs Miners",
  numerator: "GLD",
  denominator: "GDX",
  ratio: 1.2,
  mean: 0.1,
  sd: 0.05,
  zScore: 3,
  ouLambda: -0.05,
  halfLife: 14,
  meanReversion: "pass",
  cointegration: "unknown",
  tradeable: true,
  series: [],
  ...over,
});

describe("buildAlerts", () => {
  it("fires on a z-score crossing the threshold", () => {
    const drafts = buildAlerts([metrics({ putSkewZ: 3.1 })], [], [], config);
    const skew = drafts.find((d) => d.type === "skew_zscore");
    expect(skew).toBeDefined();
    expect(skew?.title).toMatch(/3\.1σ/);
  });

  it("stays quiet inside the threshold", () => {
    const drafts = buildAlerts([metrics({ putSkewZ: 1.2 })], [], [], config);
    expect(drafts.some((d) => d.type === "skew_zscore")).toBe(false);
  });

  it("fires on a term-structure inversion", () => {
    const drafts = buildAlerts(
      [metrics({ termInverted: true, termSlope: -3.2 })],
      [],
      [],
      config,
    );
    expect(drafts.some((d) => d.type === "term_inversion")).toBe(true);
  });

  // A bond ETF that starts moving WITH equities has stopped diversifying — which
  // is exactly when you needed it to be a diversifier.
  it("fires when a bond ETF's correlation to SPY flips positive", () => {
    const drafts = buildAlerts(
      [metrics({ ticker: "TLT", corrSpy60d: 0.72 })],
      [],
      [],
      config,
    );
    const alert = drafts.find((d) => d.type === "correlation_break");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("critical");
  });

  it("flags a chain that is mostly stale", () => {
    const drafts = buildAlerts(
      [metrics({ dataQuality: "poor" })],
      [],
      [],
      config,
    );
    expect(drafts.some((d) => d.type === "data_quality")).toBe(true);
  });

  // The A3 guard, applied at the alert boundary: alerting on a stretched spread
  // that never reverts is an invitation to fade a permanent trend.
  it("does NOT alert on a stretched pair that fails mean reversion", () => {
    const reverting = buildAlerts([], [pair({ zScore: 3 })], [], config);
    expect(reverting.some((d) => d.type === "pair_zscore")).toBe(true);

    const broken = buildAlerts(
      [],
      [
        pair({
          zScore: 3,
          tradeable: false,
          meanReversion: "fail",
          halfLife: 140,
        }),
      ],
      [],
      config,
    );
    expect(broken.some((d) => d.type === "pair_zscore")).toBe(false);
  });

  it("suppresses proxied alerts when configured to", () => {
    const setup = {
      scanner: "protectivePut",
      ticker: "AAPL",
      score: 9,
      legs: [],
      stats: {},
      summary: "cheap puts",
      warnings: [],
      proxied: true,
      ratesFallback: false,
      dataQuality: "good",
      signalHash: "x",
    } as unknown as Setup;

    const firing = buildAlerts([], [], [setup], config);
    expect(firing.some((d) => d.type === "scanner_top")).toBe(true);

    const suppressed = buildAlerts([], [], [setup], {
      ...config,
      alerts: { ...config.alerts, fireOnProxiedIvRank: false },
    });
    expect(suppressed.some((d) => d.type === "scanner_top")).toBe(false);
  });
});

describe("fireAlerts", () => {
  const draft: AlertDraft = {
    ticker: "SPY",
    type: "term_inversion",
    severity: "warn",
    title: "SPY: term structure inverted",
    detail: "30d above 90d.",
    proxied: false,
  };

  it("persists an alert and returns it", () => {
    const fired = fireAlerts(
      [draft],
      scanId,
      config,
      db,
      new Date("2026-07-11"),
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]?.id).toBeGreaterThan(0);
    expect(listAlerts(10, db)).toHaveLength(1);
  });

  // Without this the feed becomes wallpaper — and wallpaper gets ignored, which
  // is worse than no alert at all.
  it("does not re-fire the same alert inside the cooldown", () => {
    const day1 = new Date("2026-07-11T10:00:00Z");
    expect(fireAlerts([draft], scanId, config, db, day1)).toHaveLength(1);

    // Same day, second scan: suppressed.
    const day1pm = new Date("2026-07-11T15:30:00Z");
    expect(fireAlerts([draft], scanId, config, db, day1pm)).toHaveLength(0);

    // Still inside the 3-day cooldown.
    const day2 = new Date("2026-07-13T10:00:00Z");
    expect(fireAlerts([draft], scanId, config, db, day2)).toHaveLength(0);

    // Past it: fires again.
    const day5 = new Date("2026-07-16T10:00:00Z");
    expect(fireAlerts([draft], scanId, config, db, day5)).toHaveLength(1);

    expect(listAlerts(10, db)).toHaveLength(2);
  });

  it("cools down per (ticker, type), not globally", () => {
    const now = new Date("2026-07-11T10:00:00Z");
    fireAlerts([draft], scanId, config, db, now);

    // A different ticker with the same type still fires.
    const other = fireAlerts(
      [{ ...draft, ticker: "QQQ" }],
      scanId,
      config,
      db,
      now,
    );
    expect(other).toHaveLength(1);

    // Same ticker, a different type, also fires.
    const differentType = fireAlerts(
      [{ ...draft, type: "vrp_extreme" }],
      scanId,
      config,
      db,
      now,
    );
    expect(differentType).toHaveLength(1);
  });

  it("returns the feed newest-first", () => {
    fireAlerts([draft], scanId, config, db, new Date("2026-07-11T10:00:00Z"));
    fireAlerts(
      [{ ...draft, ticker: "QQQ", title: "QQQ inverted" }],
      scanId,
      config,
      db,
      new Date("2026-07-12T10:00:00Z"),
    );

    const feed = listAlerts(10, db);
    expect(feed[0]?.ticker).toBe("QQQ");
    expect(feed[1]?.ticker).toBe("SPY");
  });
});
