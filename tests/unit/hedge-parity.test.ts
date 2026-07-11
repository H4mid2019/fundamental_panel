import { describe, expect, it } from "vitest";

import { price } from "@/lib/hedge/math/blackScholes";
import {
  checkParity,
  gradeDataQuality,
  type ParityContext,
  type ParityLimits,
} from "@/lib/hedge/math/parity";

const ctx: ParityContext = { s: 100, t: 0.25, r: 0.05, q: 0.02 };
const limits: ParityLimits = { tolerance: 0.05, halfSpreadMult: 2 };

/** Build a quote pair around true Black-Scholes mids with a given half-spread. */
function quotePair(
  strike: number,
  halfSpread: number,
  options: { callShift?: number; putShift?: number } = {},
) {
  const inputs = { ...ctx, k: strike, sigma: 0.25 };
  const callMid = price(inputs, "call") + (options.callShift ?? 0);
  const putMid = price(inputs, "put") + (options.putShift ?? 0);
  return {
    strike,
    callBid: callMid - halfSpread,
    callAsk: callMid + halfSpread,
    putBid: putMid - halfSpread,
    putAsk: putMid + halfSpread,
  };
}

describe("checkParity", () => {
  // Black-Scholes prices satisfy parity by construction, so a clean market must
  // pass with essentially zero violation. If this fails, the pricer is wrong.
  it("passes a clean, arbitrage-free market with ~zero violation", () => {
    for (const strike of [80, 90, 100, 110, 120]) {
      const result = checkParity(quotePair(strike, 0.05), ctx, limits);
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("ok");
      expect(result.violation).toBeLessThan(1e-9);
    }
  });

  // The failure this exists to catch: one leg is stale, so C - P drifts away
  // from the arbitrage-enforced value. Yahoo chains are full of these.
  it("rejects a stale leg whose price has drifted off parity", () => {
    // The call still shows a price from before a $3 move in the underlying.
    const stale = quotePair(100, 0.05, { callShift: 3 });
    const result = checkParity(stale, ctx, limits);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("parity_violation");
    expect(result.violation).toBeCloseTo(3, 6);
    expect(result.violation).toBeGreaterThan(result.threshold);
  });

  // A wide market genuinely cannot pin C - P down, and should not be punished
  // for it — the threshold scales with the spread.
  it("grants a wide market more latitude than a tight one", () => {
    const drift = 0.4;

    // Tight market: a 0.40 discrepancy is far outside what the spread explains.
    const tight = checkParity(
      quotePair(100, 0.02, { callShift: drift }),
      ctx,
      limits,
    );
    expect(tight.ok).toBe(false);

    // Wide market: the same discrepancy is within 2x the combined half-spread.
    const wide = checkParity(
      quotePair(100, 0.3, { callShift: drift }),
      ctx,
      limits,
    );
    expect(wide.ok).toBe(true);
    expect(wide.threshold).toBeGreaterThan(tight.threshold);
  });

  // A quoted zero-width market is a lie, and with a purely spread-scaled
  // threshold it would be held to a threshold of zero and always rejected. The
  // absolute tolerance is the floor that keeps it usable.
  it("applies the absolute tolerance floor to a zero-width market", () => {
    const zeroWidth = quotePair(100, 0, { callShift: 0.01 });
    const result = checkParity(zeroWidth, ctx, limits);
    expect(result.threshold).toBe(limits.tolerance);
    expect(result.ok).toBe(true);

    // But a real violation still fails, even at zero width.
    const bad = checkParity(quotePair(100, 0, { callShift: 1 }), ctx, limits);
    expect(bad.ok).toBe(false);
  });

  it("accounts for the dividend yield — parity is q-sensitive", () => {
    // Price the legs assuming NO dividend, then test them against a q of 6%
    // (an HYG-like name). Parity must notice the mismatch.
    const noDiv = { ...ctx, q: 0 };
    const inputs = { ...noDiv, k: 100, sigma: 0.25 };
    const quote = {
      strike: 100,
      callBid: price(inputs, "call") - 0.02,
      callAsk: price(inputs, "call") + 0.02,
      putBid: price(inputs, "put") - 0.02,
      putAsk: price(inputs, "put") + 0.02,
    };

    expect(checkParity(quote, noDiv, limits).ok).toBe(true);
    // Same quotes, judged with a 6% dividend yield: the forward moves, so parity
    // breaks. This is exactly the error that ignoring q would bake in silently.
    const withDiv = checkParity(quote, { ...ctx, q: 0.06 }, limits);
    expect(withDiv.ok).toBe(false);
    expect(withDiv.violation).toBeGreaterThan(1);
  });

  it("rejects a pair with a missing or crossed quote", () => {
    const base = quotePair(100, 0.05);

    const missing = checkParity({ ...base, callBid: null }, ctx, limits);
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("missing_quote");

    // Crossed market (ask < bid) is nonsense, not a tight spread.
    const crossed = checkParity(
      { ...base, callBid: 10, callAsk: 9 },
      ctx,
      limits,
    );
    expect(crossed.ok).toBe(false);
    expect(crossed.reason).toBe("missing_quote");
  });
});

describe("gradeDataQuality", () => {
  it("grades by the fraction of contracts that survived", () => {
    expect(gradeDataQuality(100, 5, 3, 0.8, 0.5).quality).toBe("good");
    expect(gradeDataQuality(100, 35, 30, 0.8, 0.5).quality).toBe("degraded");
    expect(gradeDataQuality(100, 70, 60, 0.8, 0.5).quality).toBe("poor");
  });

  it("reports the counts it was given", () => {
    const report = gradeDataQuality(200, 40, 33, 0.8, 0.5);
    expect(report.contractsTotal).toBe(200);
    expect(report.contractsExcluded).toBe(40);
    expect(report.parityViolations).toBe(33);
    expect(report.goodFraction).toBeCloseTo(0.8, 12);
    expect(report.quality).toBe("good");
  });

  // An empty chain is the worst case, not a perfect score. A naive
  // (total - excluded) / total would hand back NaN here, and NaN >= 0.8 is
  // false, so it would land on "poor" by accident rather than by design.
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
