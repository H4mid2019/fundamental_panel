/**
 * @vitest-environment node
 *
 * Exercises the snapshot orchestrator against injected providers, so the
 * degradation guarantees are tested with no network at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type HedgeDb } from "@/lib/hedge/db/client";
import { getChainSnapshot, getLatestScan } from "@/lib/hedge/db/repo";
import { fixtureChainSnapshot } from "@/lib/hedge/fixtures";
import { mapWithConcurrency } from "@/lib/hedge/pool";
import { PolygonProvider } from "@/lib/hedge/providers/polygon";
import { TradierProvider } from "@/lib/hedge/providers/tradier";
import type { ChainProvider, ChainRequest } from "@/lib/hedge/providers/types";
import { runChainSnapshot } from "@/lib/hedge/snapshot";
import { err, ok, type AppError, type Result } from "@/lib/types";
import type { ChainSnapshot } from "@/lib/hedge/types";

const now = new Date("2026-07-11T14:00:00.000Z");

let db: HedgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

/** A provider whose behaviour is scripted per ticker. */
class ScriptedProvider implements ChainProvider {
  readonly name = "scripted";

  calls: string[] = [];

  constructor(
    private readonly script: Record<
      string,
      "ok" | "no_chain" | "error" | "no_spot" | "throw"
    >,
  ) {}

  async getChainSnapshot(
    request: ChainRequest,
  ): Promise<Result<ChainSnapshot, AppError>> {
    this.calls.push(request.ticker);
    const behaviour = this.script[request.ticker] ?? "ok";

    switch (behaviour) {
      case "no_chain":
        return err({ code: "NOT_FOUND", message: "no option chain" });
      case "error":
        return err({ code: "RATE_LIMITED", message: "429 too many requests" });
      case "throw":
        // A provider that violates the never-throw contract. The scan must
        // still survive it.
        throw new Error("provider exploded");
      case "no_spot":
        return ok({
          ...fixtureChainSnapshot(request.ticker, request.now),
          spot: null,
        });
      default:
        return ok(fixtureChainSnapshot(request.ticker, request.now));
    }
  }
}

describe("runChainSnapshot", () => {
  it("captures a clean universe and marks the scan ok", async () => {
    const provider = new ScriptedProvider({});
    const run = await runChainSnapshot({
      trigger: "manual",
      tickers: ["SPY", "QQQ", "IWM"],
      provider,
      db,
      now,
    });

    expect(run.snapshots).toHaveLength(3);
    expect(run.skipped).toEqual([]);

    const scan = getLatestScan(db);
    expect(scan?.status).toBe("ok");
    expect(scan?.tickersOk).toBe(3);
    expect(scan?.tickersFailed).toBe(0);
    expect(scan?.trigger).toBe("manual");
  });

  it("persists each captured chain, retrievable by (scan, ticker)", async () => {
    const run = await runChainSnapshot({
      trigger: "cron",
      tickers: ["SPY", "QQQ"],
      provider: new ScriptedProvider({}),
      db,
      now,
    });

    const stored = getChainSnapshot(run.scanId, "SPY", db);
    expect(stored?.ticker).toBe("SPY");
    expect(stored?.expiries.length).toBeGreaterThan(0);
    expect(stored?.spot).toBeGreaterThan(0);
  });

  // The headline guarantee from the spec: a bad ticker never crashes the scan.
  it("skips a ticker with no chain and still captures the rest", async () => {
    const run = await runChainSnapshot({
      trigger: "cron",
      // ^TNX genuinely lists zero expirations on Yahoo — the real-world case.
      tickers: ["SPY", "^TNX", "QQQ"],
      provider: new ScriptedProvider({ "^TNX": "no_chain" }),
      db,
      now,
    });

    expect(run.snapshots.map((s) => s.ticker)).toEqual(["SPY", "QQQ"]);
    expect(run.skipped).toHaveLength(1);
    expect(run.skipped[0]?.ticker).toBe("^TNX");
    expect(run.skipped[0]?.reason).toBe("no_chain");

    const scan = getLatestScan(db);
    expect(scan?.status).toBe("partial");
    expect(scan?.tickersOk).toBe(2);
    expect(scan?.tickersFailed).toBe(1);
  });

  it("skips a rate-limited ticker as a provider error", async () => {
    const run = await runChainSnapshot({
      trigger: "cron",
      tickers: ["SPY", "GME"],
      provider: new ScriptedProvider({ GME: "error" }),
      db,
      now,
    });

    expect(run.skipped[0]?.reason).toBe("provider_error");
    expect(run.skipped[0]?.detail).toMatch(/429/);
    expect(run.snapshots).toHaveLength(1);
  });

  // A chain with no spot cannot anchor a strike ladder, so every moneyness- and
  // delta-based metric would be computed against null. Skipping beats emitting
  // numbers that look real.
  it("skips a chain that has no underlying price", async () => {
    const run = await runChainSnapshot({
      trigger: "cron",
      tickers: ["SPY", "WEIRD"],
      provider: new ScriptedProvider({ WEIRD: "no_spot" }),
      db,
      now,
    });

    expect(run.skipped[0]?.ticker).toBe("WEIRD");
    expect(run.skipped[0]?.reason).toBe("no_spot");
    expect(run.snapshots).toHaveLength(1);
  });

  it("survives a provider that throws instead of returning a Result", async () => {
    const run = await runChainSnapshot({
      trigger: "cron",
      tickers: ["SPY", "BOOM", "QQQ"],
      provider: new ScriptedProvider({ BOOM: "throw" }),
      db,
      now,
    });

    expect(run.snapshots).toHaveLength(2);
    expect(run.skipped).toHaveLength(1);
    expect(run.skipped[0]?.reason).toBe("provider_error");
    expect(getLatestScan(db)?.status).toBe("partial");
  });

  it("marks the scan failed — not crashed — when every ticker fails", async () => {
    const run = await runChainSnapshot({
      trigger: "cron",
      tickers: ["A", "B"],
      provider: new ScriptedProvider({ A: "no_chain", B: "error" }),
      db,
      now,
    });

    expect(run.snapshots).toEqual([]);
    const scan = getLatestScan(db);
    expect(scan?.status).toBe("failed");
    expect(scan?.error).toMatch(/no ticker produced a usable chain/);
  });

  it("visits every ticker exactly once", async () => {
    const provider = new ScriptedProvider({});
    const tickers = ["SPY", "QQQ", "IWM", "DIA", "XLE", "XLF", "GLD"];
    await runChainSnapshot({ trigger: "cron", tickers, provider, db, now });

    expect([...provider.calls].sort()).toEqual([...tickers].sort());
  });

  it("can run without persisting, for dry runs", async () => {
    const run = await runChainSnapshot({
      trigger: "manual",
      tickers: ["SPY"],
      provider: new ScriptedProvider({}),
      db,
      now,
      persist: false,
    });

    expect(run.snapshots).toHaveLength(1);
    expect(getChainSnapshot(run.scanId, "SPY", db)).toBeNull();
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const result = await mapWithConcurrency([5, 1, 4, 2, 3], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n * 10;
    });
    expect(result).toEqual([50, 10, 40, 20, 30]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return 1;
      },
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("contains a throwing worker as null instead of rejecting", async () => {
    const result = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(result).toEqual([1, null, 3]);
  });

  it("handles an empty input", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe("provider stubs", () => {
  // The stubs exist to prove the seam: a paid feed drops in without the metrics
  // layer changing. They must report failure, not throw, like every provider.
  it("report a provider error rather than throwing", async () => {
    const request: ChainRequest = {
      ticker: "SPY",
      targetDte: [30],
      minDte: 21,
      now,
    };

    for (const provider of [new TradierProvider(), new PolygonProvider()]) {
      const result = await provider.getChainSnapshot(request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PROVIDER_ERROR");
        expect(result.error.message).toMatch(/not implemented/i);
      }
    }
  });

  it("degrade to skipped tickers instead of killing a scan", async () => {
    const run = await runChainSnapshot({
      trigger: "manual",
      tickers: ["SPY", "QQQ"],
      provider: new TradierProvider(),
      db,
      now,
    });

    expect(run.snapshots).toEqual([]);
    expect(run.skipped).toHaveLength(2);
    expect(getLatestScan(db)?.status).toBe("failed");
  });
});
