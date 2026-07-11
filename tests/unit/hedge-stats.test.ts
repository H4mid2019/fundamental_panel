import { describe, expect, it } from "vitest";

import {
  correlation,
  ewmaVolatility,
  logReturns,
  mean,
  ols,
  ouHalfLife,
  percentileRank,
  rangeRank,
  realizedVolatility,
  stdev,
  TRADING_DAYS,
  zScore,
} from "@/lib/hedge/math/stats";

/** Deterministic pseudo-random normals (Box-Muller on a seeded LCG). */
function normals(n: number, seed = 42): number[] {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state + 1) / 4294967297;
  };
  const out: number[] = [];
  while (out.length < n) {
    const u1 = rand();
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out.push(r * Math.cos(2 * Math.PI * u2));
    if (out.length < n) out.push(r * Math.sin(2 * Math.PI * u2));
  }
  return out.slice(0, n);
}

describe("mean / stdev", () => {
  it("computes the sample mean and Bessel-corrected stdev", () => {
    expect(mean([2, 4, 6])).toBeCloseTo(4, 12);
    // Sample (n-1) stdev of [2,4,6] is 2, not the population 1.633.
    expect(stdev([2, 4, 6])).toBeCloseTo(2, 12);
  });

  it("returns null rather than NaN when there is not enough data", () => {
    expect(mean([])).toBeNull();
    expect(stdev([])).toBeNull();
    expect(stdev([1])).toBeNull();
  });
});

describe("zScore", () => {
  it("measures deviation in standard deviations", () => {
    const history = [2, 4, 6]; // mean 4, sd 2
    expect(zScore(4, history)).toBeCloseTo(0, 12);
    expect(zScore(8, history)).toBeCloseTo(2, 12);
    expect(zScore(0, history)).toBeCloseTo(-2, 12);
  });

  // A constant history has zero spread, so every deviation is infinitely many
  // standard deviations. That is not a signal, it is a divide-by-zero.
  it("returns null for a history with no spread", () => {
    expect(zScore(5, [3, 3, 3, 3])).toBeNull();
    expect(zScore(5, [3])).toBeNull();
    expect(zScore(5, [])).toBeNull();
  });
});

describe("percentileRank vs rangeRank", () => {
  it("percentileRank uses the mid-rank definition", () => {
    const h = [1, 2, 3, 4];
    expect(percentileRank(0, h)).toBeCloseTo(0, 12);
    expect(percentileRank(5, h)).toBeCloseTo(100, 12);
    // 3 has one tie and two below: (2 + 0.5) / 4 = 62.5%.
    expect(percentileRank(3, h)).toBeCloseTo(62.5, 12);
  });

  it("rangeRank measures position in the high-low range", () => {
    expect(rangeRank(15, [10, 12, 20])).toBeCloseTo(50, 12);
    expect(rangeRank(10, [10, 12, 20])).toBeCloseTo(0, 12);
    expect(rangeRank(20, [10, 12, 20])).toBeCloseTo(100, 12);
  });

  // The two genuinely differ, which is why both are reported: a single spike
  // drags the *rank* down for a year while barely moving the *percentile*.
  it("diverges when the history has an outlier", () => {
    const spiky = [10, 11, 12, 11, 10, 80];
    const value = 12;
    const rank = rangeRank(value, spiky) ?? 0;
    const pct = percentileRank(value, spiky) ?? 0;
    expect(rank).toBeLessThan(5); // near the bottom of a 10..80 range
    expect(pct).toBeGreaterThan(70); // yet higher than most observations
  });

  it("returns null on empty or range-less history", () => {
    expect(percentileRank(1, [])).toBeNull();
    expect(rangeRank(1, [])).toBeNull();
    expect(rangeRank(5, [5, 5, 5])).toBeNull();
  });
});

describe("logReturns", () => {
  it("computes log returns and skips non-positive prices", () => {
    const r = logReturns([100, 110]);
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(Math.log(1.1), 12);

    expect(logReturns([100])).toEqual([]);
    expect(logReturns([])).toEqual([]);
    expect(logReturns([100, 0, 100])).toHaveLength(0);
  });
});

describe("ewmaVolatility", () => {
  const lambda = 0.94;

  // Hand-checked against the recursion: with constant |r|, the EWMA variance is
  // a fixed point at r^2, so the annualized vol is |r| * sqrt(252) * 100.
  it("matches a hand-computed fixed point on constant returns", () => {
    const r = 0.01;
    const returns = new Array<number>(200).fill(r);
    const vol = ewmaVolatility(returns, lambda);
    expect(vol).not.toBeNull();
    if (vol === null) return;

    // The seed variance is 0 (constant sample), and each step pulls variance
    // toward r^2, so after 180 updates it is r^2 to within (0.94)^180 ≈ 1e-5.
    expect(vol).toBeCloseTo(r * Math.sqrt(TRADING_DAYS) * 100, 1);
  });

  it("reproduces the recursion exactly", () => {
    const returns = normals(60).map((z) => z * 0.01);
    const seed = returns.slice(0, 20);
    const sd = stdev(seed) ?? 0;

    let variance = sd * sd;
    for (let i = 20; i < returns.length; i += 1) {
      const r = returns[i - 1] ?? 0;
      variance = lambda * variance + (1 - lambda) * r * r;
    }
    const expected = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS) * 100;

    expect(ewmaVolatility(returns, lambda)).toBeCloseTo(expected, 10);
  });

  // The whole point of EWMA over a flat window: it reacts to clustering.
  it("responds to a recent volatility shock faster than a flat 20-day window", () => {
    const calm = new Array<number>(100).fill(0.002);
    const shocked = [...calm, ...new Array<number>(5).fill(0.05)];

    const ewmaCalm = ewmaVolatility(calm, lambda) ?? 0;
    const ewmaShocked = ewmaVolatility(shocked, lambda) ?? 0;
    expect(ewmaShocked).toBeGreaterThan(ewmaCalm * 3);
  });

  it("rejects a bad lambda and too-short input", () => {
    const returns = normals(40).map((z) => z * 0.01);
    expect(ewmaVolatility(returns, 0)).toBeNull();
    expect(ewmaVolatility(returns, 1)).toBeNull();
    expect(ewmaVolatility(returns.slice(0, 10), lambda)).toBeNull();
  });
});

describe("realizedVolatility", () => {
  it("annualizes the sample stdev of the trailing window", () => {
    const returns = normals(100).map((z) => z * 0.01);
    const window = 20;
    const expected =
      (stdev(returns.slice(-window)) ?? 0) * Math.sqrt(TRADING_DAYS) * 100;
    expect(realizedVolatility(returns, window)).toBeCloseTo(expected, 10);
  });

  it("returns null without enough returns", () => {
    expect(realizedVolatility([0.01, 0.02], 20)).toBeNull();
    expect(realizedVolatility([0.01], 1)).toBeNull();
  });
});

describe("correlation", () => {
  it("is +1 for identical series and -1 for mirrored ones", () => {
    const a = [1, 2, 3, 4, 5];
    expect(correlation(a, a)).toBeCloseTo(1, 12);
    expect(
      correlation(
        a,
        a.map((x) => -x),
      ),
    ).toBeCloseTo(-1, 12);
  });

  it("is scale and shift invariant", () => {
    const a = normals(50);
    const b = a.map((x) => 3 * x + 7);
    expect(correlation(a, b)).toBeCloseTo(1, 10);
  });

  it("returns null for a degenerate or too-short series", () => {
    expect(correlation([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(correlation([1], [1])).toBeNull();
  });
});

describe("ols", () => {
  it("recovers a known slope and intercept exactly", () => {
    const x = [1, 2, 3, 4, 5];
    const y = x.map((v) => 3 + 2 * v);
    const fit = ols(x, y);
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(fit.slope).toBeCloseTo(2, 12);
    expect(fit.intercept).toBeCloseTo(3, 12);
    expect(fit.r2).toBeCloseTo(1, 12);
    expect(fit.n).toBe(5);
  });

  it("returns null when x has no variance", () => {
    expect(ols([2, 2, 2, 2], [1, 2, 3, 4])).toBeNull();
    expect(ols([1, 2], [1, 2])).toBeNull();
  });
});

describe("ouHalfLife", () => {
  /**
   * Simulate an OU process with a known half-life:
   *   ds = lambda * (s - mu) dt + sigma dW,  half_life = -ln2 / lambda
   */
  function ouSeries(halfLife: number, n: number, seed = 7): number[] {
    const lambda = -Math.LN2 / halfLife;
    const shocks = normals(n, seed);
    const out: number[] = [0];
    for (let i = 1; i < n; i += 1) {
      const prev = out[i - 1] ?? 0;
      const shock = shocks[i] ?? 0;
      out.push(prev + lambda * prev + 0.01 * shock);
    }
    return out;
  }

  it("recovers a known half-life from a simulated OU process", () => {
    for (const target of [5, 15, 30]) {
      const fit = ouHalfLife(ouSeries(target, 3000), 1, 60);
      expect(fit).not.toBeNull();
      if (!fit) continue;
      expect(fit.lambda).toBeLessThan(0);
      expect(fit.halfLife).not.toBeNull();
      // Estimation noise on a finite sample; ±25% is a fair band.
      expect(fit.halfLife ?? 0).toBeGreaterThan(target * 0.75);
      expect(fit.halfLife ?? 0).toBeLessThan(target * 1.25);
      expect(fit.verdict).toBe("pass");
    }
  });

  // THE guard. This is the pair that would otherwise be faded forever.
  it("fails a structurally broken, permanently diverging spread", () => {
    // A pure trend: one leg re-rating away from the other, never coming back.
    const diverging = Array.from({ length: 300 }, (_, i) => i * 0.01);
    const fit = ouHalfLife(diverging, 1, 60);
    expect(fit).not.toBeNull();
    if (!fit) return;
    // lambda >= 0 means no pull toward a mean at all.
    expect(fit.lambda).toBeGreaterThanOrEqual(0);
    expect(fit.halfLife).toBeNull();
    expect(fit.verdict).toBe("fail");
  });

  it("fails a random walk, which has no mean to revert to", () => {
    const shocks = normals(500, 99);
    const walk: number[] = [0];
    for (let i = 1; i < shocks.length; i += 1) {
      walk.push((walk[i - 1] ?? 0) + (shocks[i] ?? 0) * 0.01);
    }
    const fit = ouHalfLife(walk, 1, 60);
    expect(fit).not.toBeNull();
    if (!fit) return;
    // A random walk's lambda is ~0; whatever half-life falls out is not tradeable.
    if (fit.lambda < 0) {
      expect(fit.halfLife ?? 0).toBeGreaterThan(60);
      expect(fit.verdict).toBe("fail");
    } else {
      expect(fit.verdict).toBe("fail");
    }
  });

  it("fails a half-life outside the configured band", () => {
    // Far too fast: microstructure noise, not a trade.
    const fast = ouHalfLife(ouSeries(2, 2000), 5, 60);
    expect(fast?.verdict).toBe("fail");

    // Far too slow: a trend wearing a spread's clothing.
    const slow = ouHalfLife(ouSeries(200, 3000), 1, 60);
    expect(slow?.verdict).toBe("fail");
  });

  it("returns null on a series too short to fit", () => {
    expect(ouHalfLife([1, 2, 3], 1, 60)).toBeNull();
    expect(ouHalfLife([], 1, 60)).toBeNull();
  });
});
