import { describe, expect, it } from "vitest";

import { isStandardMonthly } from "@/lib/hedge/expiry";
import {
  fixtureChainSnapshot,
  fixtureSurface,
  standardMonthlies,
  surfaceIv,
} from "@/lib/hedge/fixtures";
import {
  delta,
  impliedVolatility,
  vega,
  yearsToExpiry,
} from "@/lib/hedge/math/blackScholes";

const now = new Date("2026-07-11T14:00:00.000Z");

describe("standardMonthlies", () => {
  it("emits only third Fridays, strictly in the future, in order", () => {
    const months = standardMonthlies(now, 12);
    expect(months.length).toBeGreaterThanOrEqual(12);
    for (const d of months) {
      expect(isStandardMonthly(d)).toBe(true);
      expect(d.getTime()).toBeGreaterThan(now.getTime());
    }
    for (let i = 1; i < months.length; i += 1) {
      expect(months[i]?.getTime()).toBeGreaterThan(
        months[i - 1]?.getTime() ?? 0,
      );
    }
  });
});

describe("surfaceIv", () => {
  it("prices OTM puts above OTM calls — a real equity skew", () => {
    const surface = fixtureSurface("SPY");
    const spot = 100;
    const t = 0.25;

    const otmPut = surfaceIv(surface, spot, 85, t);
    const atm = surfaceIv(surface, spot, 100, t);
    const otmCall = surfaceIv(surface, spot, 115, t);

    expect(otmPut).toBeGreaterThan(atm);
    expect(atm).toBeGreaterThan(otmCall);
  });

  it("never returns a non-positive vol, however far into the wing", () => {
    const surface = fixtureSurface("NVDA");
    for (const k of [1, 20, 100, 500, 5000]) {
      expect(surfaceIv(surface, 100, k, 0.1)).toBeGreaterThan(0);
    }
  });
});

describe("fixtureChainSnapshot", () => {
  it("is deterministic — the same inputs give a byte-identical snapshot", () => {
    expect(fixtureChainSnapshot("SPY", now)).toEqual(
      fixtureChainSnapshot("SPY", now),
    );
  });

  it("resolves skew tenors to monthlies and term tenors to any expiry", () => {
    const snap = fixtureChainSnapshot("SPY", now, {
      skew: [30, 90, 180],
      term: [14],
    });
    expect(snap.spot).toBeGreaterThan(0);
    expect(snap.fallback).toBe(true);
    expect(snap.source).toBe("fixture");

    // Three monthlies for the wings, plus a sub-30-day weekly for the ATM point.
    const monthlies = snap.expiries.filter((e) => e.standardMonthly);
    const weeklies = snap.expiries.filter((e) => !e.standardMonthly);
    expect(monthlies).toHaveLength(3);
    expect(weeklies.length).toBeGreaterThanOrEqual(1);
    expect(monthlies.every((e) => e.usableForSkew)).toBe(true);
    expect(weeklies.every((e) => !e.usableForSkew)).toBe(true);

    // Ascending DTE, as the term-structure metric requires.
    const dtes = snap.expiries.map((e) => e.dte);
    expect([...dtes].sort((a, b) => a - b)).toEqual(dtes);

    // And the 30-day point is bracketed on both sides — without this, the
    // constant-maturity ATM IV that VRP is defined on could only be extrapolated.
    expect(dtes.some((d) => d < 30)).toBe(true);
    expect(dtes.some((d) => d > 30)).toBe(true);
  });

  // The fixture deliberately gives weeklies a thin ladder and monthlies a wide
  // one, mirroring reality. A fixture with uniform ladders would let a
  // 25-delta search on a weekly pass its tests when in production it clamps.
  it("gives weeklies a ladder too thin to reach 25 delta, and monthlies one that is not", () => {
    const snap = fixtureChainSnapshot("SPY", now);
    const spot = snap.spot ?? 0;
    expect(spot).toBeGreaterThan(0);

    const monthly = snap.expiries.find((e) => e.standardMonthly);
    const weekly = snap.expiries.find((e) => !e.standardMonthly);
    expect(monthly).toBeDefined();
    expect(weekly).toBeDefined();
    if (!monthly || !weekly) return;

    const span = (e: typeof monthly) => {
      const ks = e.puts.map((p) => p.strike);
      return { lo: Math.min(...ks) / spot, hi: Math.max(...ks) / spot };
    };
    expect(span(monthly).lo).toBeLessThan(0.75);
    expect(span(monthly).hi).toBeGreaterThan(1.25);
    // The weekly cannot reach far enough down the ladder for a 25-delta put.
    expect(span(weekly).lo).toBeGreaterThan(0.85);
  });

  it("lists a strike ladder wide enough to reach a 25-delta strike", () => {
    const snap = fixtureChainSnapshot("SPY", now);
    const spot = snap.spot ?? 0;
    // Wing metrics only ever read a monthly, so that is what must bracket 25Δ.
    const front = snap.expiries.find((e) => e.usableForSkew);
    expect(front).toBeDefined();
    if (!front || spot === 0) return;

    const strikes = front.puts.map((p) => p.strike);
    expect(Math.min(...strikes)).toBeLessThan(spot * 0.75);
    expect(Math.max(...strikes)).toBeGreaterThan(spot * 1.25);

    const deltas = front.puts.map((p) =>
      Math.abs(
        delta(
          {
            s: spot,
            k: p.strike,
            t: yearsToExpiry(front.dte),
            r: 0.042,
            q: 0,
            sigma: p.impliedVolatility ?? 0.2,
          },
          "put",
        ),
      ),
    );
    // The 25-delta point is genuinely bracketed by listed strikes.
    expect(Math.min(...deltas)).toBeLessThan(0.25);
    expect(Math.max(...deltas)).toBeGreaterThan(0.25);
  });

  it("quotes a two-sided market on every contract", () => {
    const snap = fixtureChainSnapshot("AAPL", now);
    for (const expiry of snap.expiries) {
      for (const c of [...expiry.calls, ...expiry.puts]) {
        expect(c.bid).not.toBeNull();
        expect(c.ask).not.toBeNull();
        expect(c.ask ?? 0).toBeGreaterThanOrEqual(c.bid ?? 0);
        expect(c.openInterest ?? 0).toBeGreaterThan(0);
      }
    }
  });

  // The property that makes the fixture worth having: prices were generated by
  // running a known vol surface through Black-Scholes, so the solver must be
  // able to recover that surface from the mid price alone. A fixture with
  // hand-written prices could not test this at all.
  it("round-trips: the IV solver recovers the surface it was priced from", () => {
    // Every tenor, both wings, several tickers — so the recovery is proven
    // across the whole surface (strike *and* term), not one slice of it.
    let checked = 0;

    for (const ticker of ["SPY", "QQQ", "AAPL"]) {
      const snap = fixtureChainSnapshot(ticker, now);
      const surface = fixtureSurface(ticker);
      const spot = snap.spot ?? 0;
      expect(spot).toBeGreaterThan(0);

      for (const expiry of snap.expiries) {
        const t = yearsToExpiry(expiry.dte);

        // Solve on the OTM wing of each side — exactly where the metrics layer
        // solves, and the only region where IV is identifiable at all.
        const otmPuts = expiry.puts.filter((p) => p.strike < spot);
        const otmCalls = expiry.calls.filter((c) => c.strike > spot);

        for (const [contracts, right] of [
          [otmPuts, "put"],
          [otmCalls, "call"],
        ] as const) {
          for (const c of contracts) {
            const mid = ((c.bid ?? 0) + (c.ask ?? 0)) / 2;
            // A sub-2c market carries no recoverable vol information — the
            // cent-rounding on bid/ask is the same size as the premium itself.
            if (mid <= 0.02) continue;

            const inputs = { s: spot, k: c.strike, t, r: 0.042, q: 0 };
            const solved = impliedVolatility(mid, inputs, right);
            expect(solved).not.toBeNull();
            if (solved === null) continue;

            const expected = surfaceIv(surface, spot, c.strike, t);

            // The solver is exact; the only error is the fixture rounding bid
            // and ask to whole cents, which shifts the mid by up to half a cent.
            // A half-cent price error is a `0.005 / vega` volatility error, so
            // that — not an arbitrary constant — is the honest tolerance, with
            // a 30% allowance for the second-order (volga) term the
            // linearization drops. It stays very tight where it matters: on a
            // liquid strike (vega ~10) this permits 0.0007 of vol.
            const v = vega({ ...inputs, sigma: expected });
            const tolerance = (0.005 * 1.3) / Math.max(v, 1e-6) + 1e-9;

            expect(Math.abs(solved - expected)).toBeLessThanOrEqual(tolerance);
            checked += 1;
          }
        }
      }
    }

    // Guard against the assertions being vacuous.
    expect(checked).toBeGreaterThan(100);
  });

  it("does not hand back the true IV in the provider's field", () => {
    // Yahoo's own IV is stale in reality. A fixture that returned the exact
    // surface IV would let code that naively trusts the provider field pass.
    const snap = fixtureChainSnapshot("SPY", now);
    const surface = fixtureSurface("SPY");
    const spot = snap.spot ?? 0;
    const expiry = snap.expiries[0];
    if (!expiry || spot === 0) return;

    const atmish = expiry.calls.find((c) => c.strike >= spot);
    expect(atmish).toBeDefined();
    if (!atmish) return;

    const trueIv = surfaceIv(
      surface,
      spot,
      atmish.strike,
      yearsToExpiry(expiry.dte),
    );
    expect(atmish.impliedVolatility).not.toBeCloseTo(trueIv, 3);
  });
});
