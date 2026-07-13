/**
 * @vitest-environment node
 *
 * The market brief caches into SQLite, so it needs the Node runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildFallbackMarketBrief,
  buildMarketDigest,
  interpretMarket,
  marketSignalHash,
  type MarketDigest,
} from "@/lib/hedge/ai/market";
import type { AlertDraft } from "@/lib/hedge/alerts/engine";
import { openDb, type HedgeDb } from "@/lib/hedge/db/client";
import { readMarketBrief } from "@/lib/hedge/db/repo";
import type { TickerMetrics } from "@/lib/hedge/metrics/engine";
import type { Setup } from "@/lib/hedge/scanners";

let db: HedgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

const metric = (over: Partial<TickerMetrics> = {}): TickerMetrics =>
  ({
    ticker: "SPY",
    vrp: 1,
    ivRank: 50,
    ivRankProxied: false,
    putSkewZ: 0,
    termInverted: false,
    dataQuality: "good",
    ...over,
  }) as TickerMetrics;

const setup = (over: Partial<Setup> = {}): Setup =>
  ({
    scanner: "collar",
    ticker: "SPY",
    score: 1,
    legs: [],
    stats: {},
    summary: "",
    warnings: [],
    proxied: false,
    ratesFallback: false,
    dataQuality: "good",
    signalHash: "h",
    ...over,
  }) as Setup;

const tail = { firing: false, composite: 0.2 };

describe("buildMarketDigest", () => {
  it("reduces the universe to computed medians, counts and extremes", () => {
    const digest = buildMarketDigest(
      [
        metric({ ticker: "SPY", vrp: -2, ivRank: 10 }),
        metric({ ticker: "GLD", vrp: 4, ivRank: 80 }),
        metric({ ticker: "HYG", vrp: 1, ivRank: 50, dataQuality: "degraded" }),
      ],
      [setup({ ticker: "GLD", score: 9 }), setup({ ticker: "SPY", score: 3 })],
      [],
      tail,
    );

    expect(digest.tickers).toBe(3);
    expect(digest.vrpMedian).toBe(1);
    // Two of the three price implied above realized.
    expect(digest.vrpRichCount).toBe(2);
    expect(digest.vrpRichest[0]).toEqual({ ticker: "GLD", value: 4 });
    expect(digest.vrpCheapest[0]).toEqual({ ticker: "SPY", value: -2 });
    expect(digest.ivRankMedian).toBe(50);
    expect(digest.quality).toEqual({ good: 2, degraded: 1, poor: 0 });
    // Top setups are ranked, so the model reads the best trade first.
    expect(digest.topSetups[0]).toEqual({
      scanner: "collar",
      ticker: "GLD",
      score: 9,
    });
  });

  // A deeply NEGATIVE skew z-score is every bit as interesting as a positive
  // one — it is the reverse-skew case. Ranking by signed value would surface
  // only one tail and silently hide the other.
  it("ranks skew extremes by absolute value, so both tails surface", () => {
    const digest = buildMarketDigest(
      [
        metric({ ticker: "AAPL", putSkewZ: 0.2 }),
        metric({ ticker: "XLU", putSkewZ: -3.3 }),
        metric({ ticker: "QQQ", putSkewZ: 1.1 }),
      ],
      [],
      [],
      tail,
    );

    expect(digest.skewExtremes[0]).toEqual({ ticker: "XLU", value: -3.3 });
    expect(digest.skewExtremes[1]).toEqual({ ticker: "QQQ", value: 1.1 });
  });

  it("counts proxied IV ranks and inverted term structures", () => {
    const digest = buildMarketDigest(
      [
        metric({ ticker: "SPY", ivRankProxied: true }),
        metric({ ticker: "IWM", ivRankProxied: true, termInverted: true }),
        metric({ ticker: "QQQ" }),
      ],
      [],
      [],
      tail,
    );

    expect(digest.ivRankProxied).toBe(2);
    expect(digest.termInverted).toEqual(["IWM"]);
  });

  it("survives an empty universe rather than dividing by zero", () => {
    const digest = buildMarketDigest([], [], [], tail);
    expect(digest.tickers).toBe(0);
    expect(digest.vrpMedian).toBeNull();
    expect(digest.ivRankMedian).toBeNull();
  });
});

describe("marketSignalHash", () => {
  const digest = (over: Partial<MarketDigest> = {}): MarketDigest => ({
    ...buildMarketDigest([metric()], [], [], tail),
    ...over,
  });

  // The whole point of the cache: an unchanged market must never re-bill the
  // model, and a changed one must never serve a stale read.
  it("is stable for an unchanged market", () => {
    expect(marketSignalHash(digest())).toBe(marketSignalHash(digest()));
  });

  it("changes when the market does", () => {
    expect(marketSignalHash(digest())).not.toBe(
      marketSignalHash(digest({ vrpMedian: 9.9 })),
    );
  });
});

describe("buildFallbackMarketBrief", () => {
  // The offline path is not a placeholder apology. With no API key it must still
  // say something TRUE from numbers already computed, or "works with AI off" is
  // a hollow promise.
  it("states the real numbers, and expands its abbreviations", () => {
    const brief = buildFallbackMarketBrief(
      buildMarketDigest(
        [
          metric({ ticker: "SPY", vrp: -2, ivRank: 10, ivRankProxied: true }),
          metric({ ticker: "GLD", vrp: 4, ivRank: 80 }),
        ],
        [setup({ ticker: "GLD", score: 9 })],
        [],
        tail,
      ),
    );

    expect(brief.fallback).toBe(true);
    expect(brief.model).toBe("local-fallback");
    // Cites the measured figures rather than generic filler.
    expect(brief.headline).toMatch(/1/);
    expect(brief.opportunities).toMatch(/GLD/);
    expect(brief.opportunities).toMatch(/SPY/);
    // Abbreviations are expanded on first use in each field.
    expect(brief.headline).toContain("VRP (variance risk premium)");
    expect(brief.regime).toContain("IVR (implied-volatility rank)");
    // Half the universe rests on a proxy, and the brief must say so.
    expect(brief.risks).toMatch(/50%/);
  });

  it("names degraded chains as a reason to distrust the read", () => {
    const brief = buildFallbackMarketBrief(
      buildMarketDigest(
        [
          metric({ ticker: "XLU", dataQuality: "degraded" }),
          metric({ ticker: "HYG", dataQuality: "poor" }),
        ],
        [],
        [],
        tail,
      ),
    );
    expect(brief.risks).toMatch(/2 chain/);
  });
});

describe("interpretMarket", () => {
  const alerts: AlertDraft[] = [];

  it("writes a brief, caches it, and never re-bills an unchanged market", async () => {
    const digest = buildMarketDigest([metric()], [setup()], alerts, tail);
    const hash = marketSignalHash(digest);

    const first = await interpretMarket(digest, db);
    expect(first.hash).toBe(hash);
    expect(first.brief.headline.length).toBeGreaterThan(0);

    // It is durable: a restart must not lose the read, and a re-render must not
    // pay for it again.
    const stored = readMarketBrief(hash, db);
    expect(stored).not.toBeNull();
    expect(stored?.headline).toBe(first.brief.headline);

    const second = await interpretMarket(digest, db);
    expect(second.brief.headline).toBe(first.brief.headline);
  });

  it("gives a moved market a different brief, rather than serving the stale one", async () => {
    const before = buildMarketDigest(
      [metric({ vrp: -2 })],
      [setup()],
      alerts,
      tail,
    );
    const after = buildMarketDigest(
      [metric({ vrp: 8 })],
      [setup()],
      alerts,
      tail,
    );

    const a = await interpretMarket(before, db);
    const b = await interpretMarket(after, db);

    expect(a.hash).not.toBe(b.hash);
    expect(a.brief.headline).not.toBe(b.brief.headline);
  });
});
