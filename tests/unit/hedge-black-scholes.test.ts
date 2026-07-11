import { describe, expect, it } from "vitest";

import {
  delta,
  impliedVolatility,
  interpolateAtDelta,
  normalCdf,
  normalPdf,
  price,
  vega,
  yearsToExpiry,
  type BsInputs,
} from "@/lib/hedge/math/blackScholes";

/** A plain vanilla 90-day ATM contract used as the baseline across these tests. */
const base: BsInputs = { s: 100, k: 100, t: 0.25, r: 0.05, q: 0, sigma: 0.2 };

describe("normalCdf", () => {
  // Reference values computed independently via a Taylor-series erf. The tight
  // tolerances are the point: a coarser CDF passes a loose check and then
  // silently destroys the implied-vol solve on tail strikes.
  it("matches known values of the standard normal to near machine precision", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 15);
    expect(normalCdf(1)).toBeCloseTo(0.841344746069, 12);
    expect(normalCdf(-1)).toBeCloseTo(0.158655253931, 12);
    expect(normalCdf(1.96)).toBeCloseTo(0.975002104852, 12);
    expect(normalCdf(-2.58)).toBeCloseTo(0.004940015758, 12);
  });

  it("is symmetric and saturates in the tails", () => {
    for (const x of [0.3, 1.1, 2.7, 4.2]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 14);
    }
    // Crosses into the continued-fraction branch (z >= 7.07).
    expect(normalCdf(-8)).toBeGreaterThan(0);
    expect(normalCdf(-8)).toBeLessThan(1e-14);
    expect(normalCdf(-40)).toBe(0);
    expect(normalCdf(40)).toBe(1);
    expect(normalCdf(Infinity)).toBe(1);
    expect(normalCdf(-Infinity)).toBe(0);
  });
});

describe("normalPdf", () => {
  it("peaks at zero with the right normalization", () => {
    expect(normalPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 12);
    expect(normalPdf(1)).toBeCloseTo(0.2419707, 6);
  });
});

describe("price", () => {
  // Reference values from an independent high-precision implementation.
  it("prices a known European call and put", () => {
    expect(price(base, "call")).toBeCloseTo(4.6149971296, 9);
    expect(price(base, "put")).toBeCloseTo(3.372777179, 9);
  });

  it("respects put-call parity", () => {
    // C - P = S*e^{-qT} - K*e^{-rT}
    for (const k of [80, 95, 100, 110, 130]) {
      const i = { ...base, k, q: 0.015 };
      const lhs = price(i, "call") - price(i, "put");
      const rhs = i.s * Math.exp(-i.q * i.t) - i.k * Math.exp(-i.r * i.t);
      expect(lhs).toBeCloseTo(rhs, 8);
    }
  });

  it("is monotonically increasing in volatility", () => {
    let previous = -Infinity;
    for (const sigma of [0.05, 0.1, 0.2, 0.4, 0.8]) {
      const p = price({ ...base, sigma }, "call");
      expect(p).toBeGreaterThan(previous);
      previous = p;
    }
  });

  it("collapses to intrinsic value at zero time or zero vol", () => {
    expect(price({ ...base, k: 90, t: 0 }, "call")).toBe(10);
    expect(price({ ...base, k: 110, t: 0 }, "call")).toBe(0);
    expect(price({ ...base, k: 110, sigma: 0 }, "put")).toBe(10);
  });

  // A deep-ITM *European* put genuinely trades below its intrinsic value —
  // exercise is not available, so the payoff is discounted. The real
  // no-arbitrage floor is therefore the discounted intrinsic, not the raw one.
  it("respects the European no-arbitrage lower bounds", () => {
    for (const k of [60, 80, 100, 120, 140]) {
      const i = { ...base, k, q: 0.015 };
      const forward = i.s * Math.exp(-i.q * i.t);
      const discountedStrike = i.k * Math.exp(-i.r * i.t);

      expect(price(i, "call")).toBeGreaterThanOrEqual(
        Math.max(forward - discountedStrike, 0) - 1e-9,
      );
      expect(price(i, "put")).toBeGreaterThanOrEqual(
        Math.max(discountedStrike - forward, 0) - 1e-9,
      );
      // And never above the trivial upper bounds.
      expect(price(i, "call")).toBeLessThanOrEqual(forward + 1e-9);
      expect(price(i, "put")).toBeLessThanOrEqual(discountedStrike + 1e-9);
    }
  });
});

describe("delta", () => {
  it("puts an ATM call near +0.5 and an ATM put near -0.5", () => {
    expect(delta(base, "call")).toBeGreaterThan(0.5);
    expect(delta(base, "call")).toBeLessThan(0.62);
    expect(delta(base, "put")).toBeLessThan(-0.38);
    expect(delta(base, "put")).toBeGreaterThan(-0.5);
  });

  it("satisfies the parity relation deltaCall - deltaPut = e^{-qT}", () => {
    for (const k of [70, 100, 140]) {
      const i = { ...base, k, q: 0.02 };
      expect(delta(i, "call") - delta(i, "put")).toBeCloseTo(
        Math.exp(-i.q * i.t),
        10,
      );
    }
  });

  it("saturates: deep ITM calls approach 1, deep OTM approach 0", () => {
    expect(delta({ ...base, k: 10 }, "call")).toBeCloseTo(1, 4);
    expect(delta({ ...base, k: 500 }, "call")).toBeCloseTo(0, 4);
    expect(delta({ ...base, k: 500 }, "put")).toBeCloseTo(-1, 4);
    expect(delta({ ...base, k: 10 }, "put")).toBeCloseTo(0, 4);
  });

  it("matches a finite-difference derivative of price", () => {
    const h = 1e-5;
    for (const k of [85, 100, 120]) {
      for (const right of ["call", "put"] as const) {
        const up = price({ ...base, k, s: base.s + h }, right);
        const down = price({ ...base, k, s: base.s - h }, right);
        const numeric = (up - down) / (2 * h);
        expect(delta({ ...base, k }, right)).toBeCloseTo(numeric, 5);
      }
    }
  });

  it("degenerates to a step function at expiry", () => {
    expect(delta({ ...base, k: 90, t: 0 }, "call")).toBe(1);
    expect(delta({ ...base, k: 110, t: 0 }, "call")).toBe(0);
    expect(delta({ ...base, k: 110, t: 0 }, "put")).toBe(-1);
  });

  // The whole 25-delta apparatus depends on this being solvable and unique.
  it("finds a strike with |delta| ≈ 0.25 on both sides", () => {
    const findStrike = (right: "call" | "put") => {
      let lo = 1;
      let hi = 400;
      for (let n = 0; n < 200; n += 1) {
        const mid = (lo + hi) / 2;
        const d = Math.abs(delta({ ...base, k: mid }, right));
        // Call delta falls as the strike rises; put |delta| rises with it.
        const tooHigh = right === "call" ? d > 0.25 : d < 0.25;
        if (tooHigh) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };

    const callStrike = findStrike("call");
    const putStrike = findStrike("put");
    expect(Math.abs(delta({ ...base, k: callStrike }, "call"))).toBeCloseTo(
      0.25,
      6,
    );
    expect(Math.abs(delta({ ...base, k: putStrike }, "put"))).toBeCloseTo(
      0.25,
      6,
    );
    // A 25-delta call sits above spot; a 25-delta put below it.
    expect(callStrike).toBeGreaterThan(base.s);
    expect(putStrike).toBeLessThan(base.s);
  });
});

describe("vega", () => {
  it("matches a finite-difference derivative with respect to sigma", () => {
    const h = 1e-6;
    const up = price({ ...base, sigma: base.sigma + h }, "call");
    const down = price({ ...base, sigma: base.sigma - h }, "call");
    expect(vega(base)).toBeCloseTo((up - down) / (2 * h), 4);
  });

  it("is identical for calls and puts, and zero at expiry", () => {
    expect(vega({ ...base, t: 0 })).toBe(0);
    expect(vega({ ...base, sigma: 0 })).toBe(0);
  });
});

describe("impliedVolatility", () => {
  // The round trip is the property that matters: price a contract at a known
  // vol, then prove the solver recovers exactly that vol — or, where the
  // contract carries no vol information, that it declines rather than guessing.
  it("round-trips volatility across strikes, tenors and both rights", () => {
    let recovered = 0;
    let declined = 0;

    for (const sigma of [0.08, 0.15, 0.3, 0.75, 1.5]) {
      for (const k of [60, 85, 100, 115, 160]) {
        for (const t of [7 / 365, 30 / 365, 0.5, 2]) {
          for (const right of ["call", "put"] as const) {
            const i: BsInputs = { s: 100, k, t, r: 0.045, q: 0.01, sigma };
            const target = price(i, right);
            if (target <= 0) continue;

            const solved = impliedVolatility(target, i, right);

            // Vega is the identifiability test: where the premium responds to
            // vol, the solver must recover it exactly; where it does not (a
            // deep-ITM weekly, priced entirely by intrinsic value), no solver
            // can, and returning `null` is the only honest answer.
            if (vega(i) < 1e-4) {
              expect(solved).toBeNull();
              declined += 1;
            } else {
              expect(solved).not.toBeNull();
              if (solved !== null) expect(solved).toBeCloseTo(sigma, 5);
              recovered += 1;
            }
          }
        }
      }
    }

    // Guard against the assertions being vacuous — both branches must be hit.
    expect(recovered).toBeGreaterThan(100);
    expect(declined).toBeGreaterThan(0);
  });

  it("declines a deep-ITM short-dated contract instead of inventing a vol", () => {
    // Priced at 8% vol, but its premium is ~all intrinsic: an unguarded solver
    // recovers ~65% here, which is pure artefact.
    const i = { s: 100, k: 60, t: 7 / 365, r: 0.045, q: 0.01 };
    const target = price({ ...i, sigma: 0.08 }, "call");
    expect(vega({ ...i, sigma: 0.08 })).toBeLessThan(1e-4);
    expect(impliedVolatility(target, i, "call")).toBeNull();
  });

  it("converges on deep OTM contracts where vega is near zero", () => {
    // This is exactly where an unguarded Newton iteration diverges.
    const i = { s: 100, k: 250, t: 0.08, r: 0.045, q: 0 };
    const target = price({ ...i, sigma: 0.9 }, "call");
    const solved = impliedVolatility(target, i, "call");
    expect(solved).not.toBeNull();
    if (solved !== null) expect(solved).toBeCloseTo(0.9, 4);
  });

  it("returns null rather than inventing a vol for an unattainable price", () => {
    const i = { s: 100, k: 100, t: 0.25, r: 0.05, q: 0 };
    // Below the zero-vol floor (a crossed or stale market).
    expect(impliedVolatility(1e-9, i, "call")).toBeNull();
    // Above the no-arbitrage ceiling.
    expect(impliedVolatility(1000, i, "call")).toBeNull();
    // Nonsense inputs.
    expect(impliedVolatility(5, { ...i, t: 0 }, "call")).toBeNull();
    expect(impliedVolatility(-1, i, "call")).toBeNull();
    expect(impliedVolatility(Number.NaN, i, "call")).toBeNull();
    expect(impliedVolatility(5, { ...i, s: 0 }, "call")).toBeNull();
  });
});

describe("yearsToExpiry", () => {
  it("converts calendar days to years and floors at one day", () => {
    expect(yearsToExpiry(365)).toBeCloseTo(1, 10);
    expect(yearsToExpiry(30)).toBeCloseTo(30 / 365, 10);
    // Expiry day must stay strictly positive or every greek collapses.
    expect(yearsToExpiry(0)).toBeGreaterThan(0);
    expect(yearsToExpiry(-5)).toBeGreaterThan(0);
  });
});

describe("interpolateAtDelta", () => {
  const points = [
    { strike: 90, iv: 0.34, absDelta: 0.12 },
    { strike: 95, iv: 0.3, absDelta: 0.22 },
    { strike: 100, iv: 0.26, absDelta: 0.32 },
    { strike: 105, iv: 0.24, absDelta: 0.48 },
  ];

  it("interpolates IV linearly between the bracketing strikes", () => {
    const result = interpolateAtDelta(points, 0.25);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.bracketed).toBe(true);
    // 0.25 sits 30% of the way from 0.22 to 0.32, so IV ≈ 0.30 + 0.3*(0.26-0.30).
    expect(result.iv).toBeCloseTo(0.288, 6);
    // The tradable strike is the nearer of the two brackets.
    expect(result.nearestStrike).toBe(95);
  });

  it("returns an exact listed point when one sits on the target", () => {
    const result = interpolateAtDelta(points, 0.22);
    expect(result?.iv).toBeCloseTo(0.3, 10);
    expect(result?.bracketed).toBe(true);
  });

  // The thin-weekly failure mode: the chain does not reach far enough down the
  // ladder. Returning the closest point *flagged as unbracketed* is what stops a
  // clamped strike from masquerading as a real 25-delta reading.
  it("flags a non-bracketed result rather than silently clamping", () => {
    const thin = [
      { strike: 100, iv: 0.26, absDelta: 0.42 },
      { strike: 105, iv: 0.24, absDelta: 0.48 },
    ];
    const result = interpolateAtDelta(thin, 0.25);
    expect(result).not.toBeNull();
    expect(result?.bracketed).toBe(false);
    expect(result?.iv).toBeCloseTo(0.26, 10);
  });

  it("discards unusable points and returns null when nothing survives", () => {
    expect(interpolateAtDelta([], 0.25)).toBeNull();
    expect(
      interpolateAtDelta(
        [
          { strike: 100, iv: 0, absDelta: 0.25 },
          { strike: 105, iv: 0.3, absDelta: 0 },
          { strike: 110, iv: 0.3, absDelta: 1 },
          { strike: 115, iv: Number.NaN, absDelta: 0.3 },
        ],
        0.25,
      ),
    ).toBeNull();
  });
});
