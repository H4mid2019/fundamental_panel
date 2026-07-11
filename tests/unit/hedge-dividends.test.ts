import { describe, expect, it } from "vitest";

import {
  buildDividendProfile,
  toContinuousYield,
  type DividendEvent,
} from "@/lib/hedge/providers/underlying";

const now = new Date("2026-07-11T14:00:00.000Z");

/** Payments on a fixed cadence, ending `lastDaysAgo` before `now`. */
function schedule(
  amount: number,
  cadenceDays: number,
  count: number,
  lastDaysAgo: number,
): DividendEvent[] {
  const out: DividendEvent[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const ms = now.getTime() - (lastDaysAgo + i * cadenceDays) * 86_400_000;
    out.push({
      exDate: new Date(ms).toISOString().slice(0, 10),
      amount,
    });
  }
  return out;
}

describe("toContinuousYield", () => {
  // Black-Scholes discounts by e^{-qT}, a continuously compounded rate, while a
  // quoted dividend yield is a simple annual figure. 1 + y = e^q.
  it("converts a simple annual yield to its continuous equivalent", () => {
    expect(toContinuousYield(0)).toBeCloseTo(0, 12);
    expect(toContinuousYield(0.059)).toBeCloseTo(Math.log(1.059), 12);
    // 5.9% simple is 5.73% continuous — small, but free to get right.
    expect(toContinuousYield(0.059)).toBeCloseTo(0.05733, 4);
    expect(toContinuousYield(0.059)).toBeLessThan(0.059);
  });
});

describe("buildDividendProfile", () => {
  // TLT pays MONTHLY. Yahoo's `calendarEvents` returns nothing at all for ETFs,
  // so the only way to know its ex-div schedule is to infer it from the observed
  // payments — and a short TLT call absolutely carries assignment risk.
  it("infers a monthly cadence and projects the next ex-dividend date", () => {
    const history = schedule(0.318, 30, 6, 10);
    const profile = buildDividendProfile(history, 4.53, 84.47, now);

    expect(profile.cadenceDays).toBeCloseTo(30, 0);
    expect(profile.nextAmount).toBeCloseTo(0.318, 6);
    expect(profile.nextExDate).not.toBeNull();

    // The last payment was 10 days ago on a 30-day cycle, so the next is ~20
    // days out — in the future, which is the whole point of projecting it.
    // (Ex-dates are calendar days at UTC midnight, so allow a day of slack.)
    const nextMs = Date.parse(profile.nextExDate ?? "");
    expect(nextMs).toBeGreaterThan(now.getTime());
    const daysOut = (nextMs - now.getTime()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(18);
    expect(daysOut).toBeLessThan(21);
  });

  it("infers a quarterly cadence for a stock", () => {
    const history = schedule(0.27, 91, 4, 30);
    const profile = buildDividendProfile(history, 0.34, 315.32, now);
    expect(profile.cadenceDays).toBeCloseTo(91, 0);
    expect(Date.parse(profile.nextExDate ?? "")).toBeGreaterThan(now.getTime());
  });

  // The trap. Yahoo's `trailingAnnualDividendYield` says TLT yields 2.55%; the
  // actual cash flows say 4.52%. Deriving q from the payments themselves is
  // immune to whichever field Yahoo decides to under-report today.
  it("derives q from the observed cash flows, not the quoted field", () => {
    const history = schedule(0.318, 30, 12, 5);
    // Deliberately pass a WRONG quoted yield (the stale trailing one).
    const profile = buildDividendProfile(history, 2.55, 84.47, now);

    // 0.318 x (365/30) / 84.47 = 4.58% simple -> ~4.48% continuous.
    const expectedSimple = (0.318 * (365 / 30)) / 84.47;
    expect(profile.q).toBeCloseTo(toContinuousYield(expectedSimple), 6);
    expect(profile.fallback).toBe(false);

    // Emphatically NOT the 2.55% the quoted field claimed.
    expect(profile.q ?? 0).toBeGreaterThan(0.04);
  });

  it("falls back to the quoted yield when there is no usable history", () => {
    const profile = buildDividendProfile([], 4.53, 84.47, now);
    expect(profile.q).toBeCloseTo(toContinuousYield(0.0453), 8);
    expect(profile.fallback).toBe(false);
    expect(profile.cadenceDays).toBeNull();
    expect(profile.nextExDate).toBeNull();
  });

  // GLD pays nothing. That is a fact, not a missing value, and q = 0 is correct.
  it("handles a non-payer without flagging a fallback", () => {
    const profile = buildDividendProfile([], 0, 380, now);
    expect(profile.q).toBe(0);
    expect(profile.fallback).toBe(false);
    expect(profile.nextExDate).toBeNull();
  });

  it("flags a fallback when neither cash flows nor a quoted yield exist", () => {
    const profile = buildDividendProfile([], undefined, 100, now);
    expect(profile.q).toBeNull();
    expect(profile.fallback).toBe(true);
  });

  it("rejects an implausible yield rather than poisoning every delta", () => {
    // A 90% "dividend yield" is a data error, not a security.
    const profile = buildDividendProfile([], 90, 100, now);
    expect(profile.q).toBeNull();
    expect(profile.fallback).toBe(true);
  });

  it("rolls a stale projection forward past today", () => {
    // The last observed payment is 100 days old on a 30-day cycle — we simply
    // have not seen the intervening ones. The projection must still land ahead.
    const history = schedule(0.3, 30, 4, 100);
    const profile = buildDividendProfile(history, 4.5, 84, now);
    expect(Date.parse(profile.nextExDate ?? "")).toBeGreaterThan(now.getTime());
  });

  it("needs two payments to infer a cadence", () => {
    const profile = buildDividendProfile(
      [{ exDate: "2026-06-01", amount: 0.3 }],
      1.5,
      100,
      now,
    );
    expect(profile.cadenceDays).toBeNull();
    expect(profile.nextExDate).toBeNull();
    // ...but the quoted yield still gives a usable q.
    expect(profile.q).toBeCloseTo(toContinuousYield(0.015), 8);
  });
});
