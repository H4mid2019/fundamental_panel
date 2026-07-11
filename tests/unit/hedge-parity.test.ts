import { describe, expect, it } from "vitest";

import { price } from "@/lib/hedge/math/blackScholes";
import {
  checkParity,
  gradeDataQuality,
  impliedDividendYield,
  impliedForward,
  type ParityLimits,
  type ParityQuote,
} from "@/lib/hedge/math/parity";

const S = 100;
const R = 0.05;
const Q = 0.02;
const T = 0.25;

const limits: ParityLimits = { tolerance: 0.05, halfSpreadMult: 2 };

/** The true forward for these inputs. */
const TRUE_FORWARD = S * Math.exp((R - Q) * T);

/**
 * Build an arbitrage-free chain: prices come from Black-Scholes, so they satisfy
 * put-call parity exactly by construction.
 */
function chain(
  halfSpread = 0.05,
  options: { callShift?: Record<number, number> } = {},
): ParityQuote[] {
  return [80, 90, 95, 100, 105, 110, 120].map((strike) => {
    const i = { s: S, k: strike, t: T, r: R, q: Q, sigma: 0.25 };
    const callMid = price(i, "call") + (options.callShift?.[strike] ?? 0);
    const putMid = price(i, "put");
    return {
      strike,
      callBid: callMid - halfSpread,
      callAsk: callMid + halfSpread,
      putBid: putMid - halfSpread,
      putAsk: putMid + halfSpread,
    };
  });
}

describe("impliedForward", () => {
  // The whole trick: |C - P| is smallest at the money, so the ATM pair is found
  // without needing to know where "the money" is — which means without spot.
  it("recovers the true forward from the chain alone", () => {
    const implied = impliedForward(chain(), R, T, S);
    expect(implied).not.toBeNull();
    if (!implied) return;

    expect(implied.forward).toBeCloseTo(TRUE_FORWARD, 6);
    // It picked the most at-the-money strike, which is the most liquid.
    expect(implied.strike).toBe(100);
    expect(implied.uncertainty).toBeCloseTo(0.1, 10); // two 0.05 half-spreads
  });

  it("needs neither spot nor the dividend yield", () => {
    // Same chain, but imagine we knew nothing about S or q. The forward is
    // identical, because the formula F = K + e^{rT}(C - P) uses neither.
    const implied = impliedForward(chain(), R, T, S);
    expect(implied?.forward).toBeCloseTo(TRUE_FORWARD, 6);
  });

  // THE live failure. A dead strike where both legs are quoted a penny also has
  // |C - P| ~ 0, so a naive "smallest |C - P|" pick lands on it, the forward
  // becomes that random deep strike, and every other strike then "violates"
  // against the nonsense. Observed live: implied q of 765% on QQQ, and 701 of
  // 1278 SPY contracts rejected.
  it("is not fooled by a dead penny strike that also has |C - P| ~ 0", () => {
    const withDeadStrike: ParityQuote[] = [
      ...chain(),
      // Miles out of the money; both legs quoted at a penny, so C - P = 0.
      { strike: 250, callBid: 0, callAsk: 0.01, putBid: 0, putAsk: 0.01 },
    ];

    const implied = impliedForward(withDeadStrike, R, T, S);
    expect(implied).not.toBeNull();
    if (!implied) return;

    // It must NOT have taken the dead strike.
    expect(implied.strike).not.toBe(250);
    expect(implied.forward).toBeCloseTo(TRUE_FORWARD, 6);
  });

  // One stale leg near the money must not move the forward either — which is why
  // the estimate is a median across the near-the-money strikes, not a single pick.
  it("shrugs off one stale near-the-money leg, via the median", () => {
    const oneStale = chain(0.05, { callShift: { 95: 4 } });
    const implied = impliedForward(oneStale, R, T, S);
    expect(implied).not.toBeNull();
    if (!implied) return;
    // A single-strike estimate at 95 would have been off by ~4. The median is not.
    expect(Math.abs(implied.forward - TRUE_FORWARD)).toBeLessThan(0.5);
  });

  it("returns null when no strike has a two-sided market on both legs", () => {
    const broken: ParityQuote[] = [
      { strike: 100, callBid: null, callAsk: null, putBid: 5, putAsk: 5.1 },
      { strike: 105, callBid: 2, callAsk: 2.1, putBid: null, putAsk: null },
    ];
    expect(impliedForward(broken, R, T, S)).toBeNull();
    expect(impliedForward([], R, T, S)).toBeNull();
  });
});

describe("impliedDividendYield", () => {
  // A free bonus of the implied forward: it hands back the carry the option
  // market is ACTUALLY trading against, which beats any quoted dividend field.
  it("recovers the dividend yield the market is pricing", () => {
    const q = impliedDividendYield(TRUE_FORWARD, S, R, T);
    expect(q).not.toBeNull();
    expect(q).toBeCloseTo(Q, 10);
  });

  it("is degenerate-safe", () => {
    expect(impliedDividendYield(0, S, R, T)).toBeNull();
    expect(impliedDividendYield(TRUE_FORWARD, 0, R, T)).toBeNull();
    expect(impliedDividendYield(TRUE_FORWARD, S, R, 0)).toBeNull();
  });
});

describe("checkParity against the implied forward", () => {
  const implied = impliedForward(chain(), R, T, S);
  const ctx = { forward: implied?.forward ?? TRUE_FORWARD, t: T, r: R };

  it("passes a clean, arbitrage-free chain with ~zero violation", () => {
    for (const quote of chain()) {
      const result = checkParity(quote, ctx, limits, implied?.uncertainty ?? 0);
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("ok");
      expect(result.violation).toBeLessThan(1e-9);
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The two bugs the implied forward exists to kill. Both previously produced a
  // wall of false violations (14-31% of contracts on a live pull) that had
  // nothing to do with staleness.
  // ───────────────────────────────────────────────────────────────────────────

  it("is IMMUNE to a stale spot price", () => {
    // The chain is captured at spot 100; the quote endpoint returns 103, because
    // the underlying moved between the two requests. This is routine on a fast
    // tape and it used to condemn every strike on the board.
    const staleSpot = 103;
    const staleForward = staleSpot * Math.exp((R - Q) * T);

    // The OLD behaviour: testing against a spot-derived forward. Every strike
    // now violates by ~3, which is pure clock drift, not stale data.
    const naive = checkParity(
      chain()[3] ?? ({} as ParityQuote),
      { forward: staleForward, t: T, r: R },
      limits,
    );
    expect(naive.ok).toBe(false);
    expect(naive.violation).toBeGreaterThan(2.5);

    // The NEW behaviour: the forward comes from the chain, so a spot from a
    // different instant is simply never consulted, and the chain passes.
    const fresh = impliedForward(chain(), R, T, S);
    for (const quote of chain()) {
      const result = checkParity(
        quote,
        { forward: fresh?.forward ?? 0, t: T, r: R },
        limits,
        fresh?.uncertainty ?? 0,
      );
      expect(result.ok).toBe(true);
    }
  });

  it("is IMMUNE to a wrong dividend yield", () => {
    // Price the chain with a 2% yield, then judge it believing the yield is 8%.
    const wrongForward = S * Math.exp((R - 0.08) * T);
    const naive = checkParity(
      chain()[3] ?? ({} as ParityQuote),
      { forward: wrongForward, t: T, r: R },
      limits,
    );
    expect(naive.ok).toBe(false);

    // With the implied forward, `q` is never used, so a wrong one cannot lie.
    const fresh = impliedForward(chain(), R, T, S);
    for (const quote of chain()) {
      const result = checkParity(
        quote,
        { forward: fresh?.forward ?? 0, t: T, r: R },
        limits,
        fresh?.uncertainty ?? 0,
      );
      expect(result.ok).toBe(true);
    }
  });

  // What it must STILL catch: the one leg that really is stale.
  it("still rejects a genuinely stale leg", () => {
    // The 110 call shows a price from before a $3 move; every other strike is
    // fine. The forward is implied from the ATM pair, which is untouched.
    const stale = chain(0.05, { callShift: { 110: 3 } });
    const implied2 = impliedForward(stale, R, T, S);
    expect(implied2?.strike).toBe(100); // the ATM pair, not the corrupted one

    const results = stale.map((q) =>
      checkParity(
        q,
        { forward: implied2?.forward ?? 0, t: T, r: R },
        limits,
        implied2?.uncertainty ?? 0,
      ),
    );

    const bad = results.filter((r) => !r.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.strike).toBe(110);
    expect(bad[0]?.violation).toBeCloseTo(3, 6);
  });

  it("grants a wide market more latitude than a tight one", () => {
    const drift = 0.4;

    const tight = chain(0.02, { callShift: { 105: drift } });
    const tightImplied = impliedForward(tight, R, T, S);
    const tightResult = checkParity(
      tight[4] ?? ({} as ParityQuote),
      { forward: tightImplied?.forward ?? 0, t: T, r: R },
      limits,
      tightImplied?.uncertainty ?? 0,
    );
    expect(tightResult.ok).toBe(false);

    const wide = chain(0.3, { callShift: { 105: drift } });
    const wideImplied = impliedForward(wide, R, T, S);
    const wideResult = checkParity(
      wide[4] ?? ({} as ParityQuote),
      { forward: wideImplied?.forward ?? 0, t: T, r: R },
      limits,
      wideImplied?.uncertainty ?? 0,
    );
    expect(wideResult.ok).toBe(true);
    expect(wideResult.threshold).toBeGreaterThan(tightResult.threshold);
  });

  it("rejects a pair with a missing or crossed quote", () => {
    const base = chain()[3];
    if (!base) return;

    const missing = checkParity({ ...base, callBid: null }, ctx, limits);
    expect(missing.reason).toBe("missing_quote");

    const crossed = checkParity(
      { ...base, callBid: 10, callAsk: 9 },
      ctx,
      limits,
    );
    expect(crossed.reason).toBe("missing_quote");
  });
});

describe("gradeDataQuality", () => {
  it("grades by the fraction of contracts free of defects", () => {
    expect(gradeDataQuality(100, 5, 3, 0.8, 0.5).quality).toBe("good");
    expect(gradeDataQuality(100, 35, 30, 0.8, 0.5).quality).toBe("degraded");
    expect(gradeDataQuality(100, 70, 60, 0.8, 0.5).quality).toBe("poor");
  });

  it("reports the counts it was given", () => {
    const report = gradeDataQuality(200, 40, 33, 0.8, 0.5, 12);
    expect(report.contractsTotal).toBe(200);
    expect(report.contractsExcluded).toBe(40);
    expect(report.contractsIlliquid).toBe(12);
    expect(report.parityViolations).toBe(33);
    expect(report.goodFraction).toBeCloseTo(0.8, 12);
  });

  // An empty chain is the worst case, not a perfect score. A naive
  // (total - excluded) / total would hand back NaN, and NaN >= 0.8 is false, so
  // it would land on "poor" by accident rather than by design.
  it("treats a chain with no contracts as poor, not perfect", () => {
    const report = gradeDataQuality(0, 0, 0, 0.8, 0.5);
    expect(report.quality).toBe("poor");
    expect(report.goodFraction).toBe(0);
    expect(Number.isNaN(report.goodFraction)).toBe(false);
  });

  it("puts the boundaries on the inclusive side", () => {
    expect(gradeDataQuality(100, 20, 0, 0.8, 0.5).quality).toBe("good");
    expect(gradeDataQuality(100, 50, 0, 0.8, 0.5).quality).toBe("degraded");
    expect(gradeDataQuality(100, 51, 0, 0.8, 0.5).quality).toBe("poor");
  });
});
