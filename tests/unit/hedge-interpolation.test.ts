import { describe, expect, it } from "vitest";

import {
  atmIvAtTenor,
  ivAtDelta,
  pchip,
  type DeltaPoint,
  type TenorPoint,
} from "@/lib/hedge/math/interpolation";

describe("pchip", () => {
  const line = [
    { x: 0, y: 0 },
    { x: 1, y: 2 },
    { x: 2, y: 4 },
    { x: 3, y: 6 },
  ];

  it("reproduces the knots exactly", () => {
    for (const p of line) {
      expect(pchip(line, p.x)).toBeCloseTo(p.y, 10);
    }
  });

  it("is exact on collinear data", () => {
    expect(pchip(line, 0.5)).toBeCloseTo(1, 10);
    expect(pchip(line, 2.25)).toBeCloseTo(4.5, 10);
  });

  it("interpolates two points linearly", () => {
    const two = [
      { x: 0, y: 10 },
      { x: 4, y: 20 },
    ];
    expect(pchip(two, 1)).toBeCloseTo(12.5, 10);
    expect(pchip(two, 3)).toBeCloseTo(17.5, 10);
  });

  // The property that makes PCHIP the right choice: a natural cubic spline
  // through this data dips *below* zero between the flat knots, inventing a
  // wiggle the data never contained. A vol smile must never do that.
  it("preserves monotonicity and never overshoots — the reason it is not a natural spline", () => {
    const step = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
      { x: 5, y: 1 },
    ];
    for (let x = 0; x <= 5; x += 0.05) {
      const y = pchip(step, x);
      expect(y).not.toBeNull();
      if (y === null) continue;
      expect(y).toBeGreaterThanOrEqual(-1e-12);
      expect(y).toBeLessThanOrEqual(1 + 1e-12);
    }
    // Monotone non-decreasing throughout.
    let previous = -Infinity;
    for (let x = 0; x <= 5; x += 0.05) {
      const y = pchip(step, x) ?? 0;
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
  });

  it("stays within the bracketing values on a decreasing curve", () => {
    const smile = [
      { x: 0.1, y: 0.34 },
      { x: 0.25, y: 0.29 },
      { x: 0.5, y: 0.24 },
      { x: 0.75, y: 0.22 },
    ];
    for (let x = 0.1; x <= 0.75; x += 0.01) {
      const y = pchip(smile, x);
      expect(y).not.toBeNull();
      if (y === null) continue;
      expect(y).toBeLessThanOrEqual(0.34 + 1e-12);
      expect(y).toBeGreaterThanOrEqual(0.22 - 1e-12);
    }
  });

  // Rule 1 of this module.
  it("refuses to extrapolate", () => {
    expect(pchip(line, -0.001)).toBeNull();
    expect(pchip(line, 3.001)).toBeNull();
    expect(pchip(line, Number.NaN)).toBeNull();
  });

  it("handles unsorted input and duplicate x values", () => {
    const messy = [
      { x: 2, y: 4 },
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 1, y: 99 }, // duplicate x — must not divide by zero
    ];
    const y = pchip(messy, 0.5);
    expect(y).not.toBeNull();
    expect(Number.isFinite(y ?? Number.NaN)).toBe(true);
  });

  it("degenerates safely", () => {
    expect(pchip([], 1)).toBeNull();
    expect(pchip([{ x: 1, y: 5 }], 1)).toBe(5);
    expect(pchip([{ x: 1, y: 5 }], 2)).toBeNull();
  });
});

describe("ivAtDelta", () => {
  // A realistic put wing: IV rises as |delta| falls (further out of the money).
  const wing: DeltaPoint[] = [
    { strike: 85, iv: 0.34, absDelta: 0.12 },
    { strike: 90, iv: 0.3, absDelta: 0.22 },
    { strike: 95, iv: 0.26, absDelta: 0.32 },
    { strike: 100, iv: 0.24, absDelta: 0.48 },
  ];

  it("interpolates IV at exactly 25 delta", () => {
    const result = ivAtDelta(wing, 0.25);
    expect(result).not.toBeNull();
    if (!result) return;
    // Between the 0.22 (IV 0.30) and 0.32 (IV 0.26) knots.
    expect(result.iv).toBeLessThan(0.3);
    expect(result.iv).toBeGreaterThan(0.26);
    // The tradable strike is the nearest genuinely listed one.
    expect(result.nearestStrike).toBe(90);
  });

  it("returns a listed point exactly when one sits on the target", () => {
    const result = ivAtDelta(wing, 0.22);
    expect(result?.iv).toBeCloseTo(0.3, 10);
    expect(result?.nearestStrike).toBe(90);
  });

  // THE guard. A thin weekly ladder cannot reach 25 delta; the old behaviour was
  // to clamp to the deepest listed strike and hand it back as if it were the
  // 25-delta IV, which is a wrong number that looks exactly like a right one.
  it("returns null rather than clamping when the chain does not bracket 25 delta", () => {
    const thin: DeltaPoint[] = [
      { strike: 98, iv: 0.25, absDelta: 0.42 },
      { strike: 100, iv: 0.24, absDelta: 0.48 },
    ];
    expect(ivAtDelta(thin, 0.25)).toBeNull();

    // Bracketed only from the other side: still no.
    const shallow: DeltaPoint[] = [
      { strike: 80, iv: 0.4, absDelta: 0.05 },
      { strike: 85, iv: 0.36, absDelta: 0.11 },
    ];
    expect(ivAtDelta(shallow, 0.25)).toBeNull();
  });

  it("never returns an IV outside the bracketing knots", () => {
    for (let target = 0.13; target <= 0.47; target += 0.01) {
      const result = ivAtDelta(wing, target);
      expect(result).not.toBeNull();
      if (!result) continue;
      expect(result.iv).toBeLessThanOrEqual(0.34 + 1e-9);
      expect(result.iv).toBeGreaterThanOrEqual(0.24 - 1e-9);
    }
  });

  it("discards unusable points and needs at least two survivors", () => {
    expect(ivAtDelta([], 0.25)).toBeNull();
    expect(
      ivAtDelta(
        [
          { strike: 100, iv: 0, absDelta: 0.25 }, // no IV
          { strike: 105, iv: 0.3, absDelta: 0 }, // no delta
          { strike: 110, iv: 0.3, absDelta: 1 }, // delta pinned at 1
          { strike: 115, iv: Number.NaN, absDelta: 0.3 },
        ],
        0.25,
      ),
    ).toBeNull();
  });
});

describe("atmIvAtTenor", () => {
  const points: TenorPoint[] = [
    { t: 17 / 365, iv: 0.18 },
    { t: 41 / 365, iv: 0.2 },
    { t: 96 / 365, iv: 0.22 },
    { t: 187 / 365, iv: 0.24 },
  ];

  it("returns a knot exactly", () => {
    expect(atmIvAtTenor(points, 41 / 365)).toBeCloseTo(0.2, 10);
    expect(atmIvAtTenor(points, 96 / 365)).toBeCloseTo(0.22, 10);
  });

  // The formula, verified by hand: w = sigma^2 * t, linear in t, then back out.
  it("interpolates linearly in total variance, not in IV", () => {
    const t1 = 17 / 365;
    const t2 = 41 / 365;
    const t = 30 / 365;

    const w1 = 0.18 ** 2 * t1;
    const w2 = 0.2 ** 2 * t2;
    const w = w1 + ((w2 - w1) * (t - t1)) / (t2 - t1);
    const expected = Math.sqrt(w / t);

    const actual = atmIvAtTenor(points, t);
    expect(actual).not.toBeNull();
    if (actual === null) return;
    expect(actual).toBeCloseTo(expected, 12);

    // And it must differ from the naive linear-in-IV answer, or the whole
    // correction is a no-op. Linear-in-IV would give:
    const naive = 0.18 + ((0.2 - 0.18) * (t - t1)) / (t2 - t1);
    expect(Math.abs(actual - naive)).toBeGreaterThan(1e-6);
  });

  // Total variance must be non-decreasing in time or the surface admits a
  // calendar-spread arbitrage. This is the invariant the method exists to hold.
  it("produces total variance that is non-decreasing across the curve", () => {
    let previousW = -Infinity;
    for (let days = 17; days <= 187; days += 1) {
      const t = days / 365;
      const iv = atmIvAtTenor(points, t);
      expect(iv).not.toBeNull();
      if (iv === null) continue;
      const w = iv * iv * t;
      expect(w).toBeGreaterThanOrEqual(previousW - 1e-12);
      previousW = w;
    }
  });

  it("handles an inverted term structure without going imaginary", () => {
    const inverted: TenorPoint[] = [
      { t: 17 / 365, iv: 0.45 }, // event-driven front-month spike
      { t: 96 / 365, iv: 0.25 },
    ];
    const iv = atmIvAtTenor(inverted, 30 / 365);
    expect(iv).not.toBeNull();
    if (iv === null) return;
    expect(iv).toBeGreaterThan(0);
    // Between the two, and closer to the front.
    expect(iv).toBeLessThan(0.45);
    expect(iv).toBeGreaterThan(0.25);
  });

  // Rule 1 again: this is exactly why the config demands a sub-30-day tenor.
  it("refuses to extrapolate beyond the captured expiries", () => {
    const monthliesOnly: TenorPoint[] = [
      { t: 41 / 365, iv: 0.2 },
      { t: 96 / 365, iv: 0.22 },
    ];
    // 30 days is BELOW the front expiry — no bracket, no answer, no VRP.
    expect(atmIvAtTenor(monthliesOnly, 30 / 365)).toBeNull();
    // And beyond the back expiry.
    expect(atmIvAtTenor(monthliesOnly, 200 / 365)).toBeNull();
  });

  it("degenerates safely", () => {
    expect(atmIvAtTenor([], 30 / 365)).toBeNull();
    expect(atmIvAtTenor(points, 0)).toBeNull();
    expect(atmIvAtTenor(points, -1)).toBeNull();
    expect(atmIvAtTenor([{ t: 30 / 365, iv: 0.2 }], 30 / 365)).toBeCloseTo(
      0.2,
      10,
    );
  });
});
