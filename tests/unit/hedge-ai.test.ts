/**
 * @vitest-environment node
 *
 * The AI layer caches into SQLite, so it needs the Node runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildFallbackInterpretation,
  interpretSetups,
} from "@/lib/hedge/ai/interpret";
import { openDb, type HedgeDb } from "@/lib/hedge/db/client";
import type { Setup } from "@/lib/hedge/scanners";

let db: HedgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

const setup = (over: Partial<Setup> = {}): Setup =>
  ({
    scanner: "protectivePut",
    ticker: "AAPL",
    score: 4.2,
    legs: [
      {
        action: "buy",
        right: "put",
        strike: 300,
        expiration: "2026-09-18",
        dte: 68,
        mid: 8.4,
        iv: 0.27,
        absDelta: 0.28,
        openInterest: 4200,
        relSpread: 0.02,
      },
    ],
    stats: {
      ivRank: 12,
      vrp: -6.5,
      costPct: 2.7,
      annualizedCost: 14.5,
      floorPct: -4.9,
    },
    summary: "Buy the Sep 300 put.",
    warnings: [],
    proxied: false,
    ratesFallback: false,
    dataQuality: "good",
    signalHash: "abc123",
    ...over,
  }) as Setup;

describe("buildFallbackInterpretation", () => {
  // The offline path is not a placeholder apology — it must say something true
  // and useful from numbers already computed, or the "works with AI disabled"
  // promise is hollow.
  it("says something concrete using the setup's own numbers", () => {
    const i = buildFallbackInterpretation(setup());

    expect(i.fallback).toBe(true);
    expect(i.model).toBe("local-fallback");
    expect(i.ticker).toBe("AAPL");
    // Quotes the actual figures, not generic filler.
    expect(i.meaning).toMatch(/12/);
    expect(i.meaning).toMatch(/2\.7/);
    expect(i.risk.length).toBeGreaterThan(20);
    // The invalidation must be falsifiable, not a horoscope.
    expect(i.invalidation).toMatch(/IV rank|trend/i);
  });

  it("folds a setup's warnings into the risk, rather than hiding them", () => {
    const i = buildFallbackInterpretation(
      setup({
        warnings: ["IV rank is proxied from realized vol (3 real days)"],
      }),
    );
    expect(i.risk).toMatch(/proxied/i);
  });

  it("has a distinct reading for each scanner", () => {
    const scanners = [
      "protectivePut",
      "putDebitSpread",
      "callCredit",
      "collar",
      "tailHedge",
    ] as const;
    const meanings = new Set(
      scanners.map(
        (s) => buildFallbackInterpretation(setup({ scanner: s })).meaning,
      ),
    );
    expect(meanings.size).toBe(scanners.length);
  });
});

describe("interpretSetups", () => {
  // No API key configured in the test env, so this exercises the offline path —
  // which is exactly the path that must work for the dashboard to be usable with
  // AI switched off.
  it("interprets every setup with no API key", async () => {
    const setups = [
      setup({ ticker: "AAPL", signalHash: "h1" }),
      setup({ ticker: "SPY", signalHash: "h2", scanner: "collar" }),
    ];

    const out = await interpretSetups(setups, db);

    expect(out.size).toBe(2);
    expect(out.get("h1")?.ticker).toBe("AAPL");
    expect(out.get("h2")?.ticker).toBe("SPY");
    expect(out.get("h1")?.fallback).toBe(true);
  });

  // The whole point of keying the cache by `(ticker, signal_hash)`: an unchanged
  // signal must never re-bill the model on a re-render.
  it("caches durably, so an unchanged signal is not recomputed", async () => {
    const s = setup({ signalHash: "stable" });

    await interpretSetups([s], db);

    const rows = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM ai_cache");
    expect(rows[0]?.n).toBe(1);

    // Tamper with the cached row so a cache HIT is distinguishable from a
    // freshly-computed fallback.
    db.run(
      `UPDATE ai_cache SET payload = :payload WHERE signal_hash = 'stable'`,
      {
        payload: JSON.stringify({
          ticker: "AAPL",
          meaning: "CACHED",
          risk: "CACHED",
          invalidation: "CACHED",
        }),
      },
    );

    const second = await interpretSetups([s], db);
    expect(second.get("stable")?.meaning).toBe("CACHED");

    // Still one row: nothing was recomputed or duplicated.
    const after = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM ai_cache");
    expect(after[0]?.n).toBe(1);
  });

  it("treats a changed signal as a new one", async () => {
    await interpretSetups([setup({ signalHash: "v1" })], db);
    await interpretSetups([setup({ signalHash: "v2" })], db);

    const rows = db.all<{ n: number }>("SELECT COUNT(*) AS n FROM ai_cache");
    expect(rows[0]?.n).toBe(2);
  });

  it("handles an empty list", async () => {
    expect((await interpretSetups([], db)).size).toBe(0);
  });
});
