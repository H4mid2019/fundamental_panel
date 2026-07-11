/**
 * Deterministic option-chain fixtures.
 *
 * These serve three jobs at once, which is why they are richer than the
 * `getOptionsFixture` used by the `/` panel (11 strikes, no bid/ask — far too
 * thin to find a 25-delta strike on):
 *
 *  1. the `USE_FIXTURES` / no-network fallback, so a scan degrades instead of
 *     failing;
 *  2. the corpus the metrics tests run against, so the math is testable with no
 *     network at all;
 *  3. a *round-trippable* corpus: every contract is priced by running a known
 *     volatility surface through Black-Scholes, so a test can assert that the
 *     IV solver recovers the surface it was priced from. A fixture with
 *     hand-written prices could not prove that.
 *
 * The surface has a real equity skew — OTM puts carry more vol than OTM calls —
 * because a flat-vol fixture would let a broken skew calculation pass its tests.
 */

import { isStandardMonthly, toIsoDate } from "./expiry";
import { price, delta, yearsToExpiry } from "./math/blackScholes";
import type {
  ChainSnapshot,
  HedgeContract,
  HedgeExpiry,
  OptionRight,
} from "./types";

/** Stable per-ticker seed, so every run of a fixture is byte-identical. */
function seed(ticker: string): number {
  let h = 5381;
  for (let i = 0; i < ticker.length; i += 1) {
    h = (h * 33) ^ ticker.charCodeAt(i);
  }
  return (h >>> 0) / 0xffffffff;
}

/** Strike ladder granularity, mirroring how real chains are listed. */
function strikeStep(spot: number): number {
  if (spot >= 500) return 10;
  if (spot >= 200) return 5;
  if (spot >= 50) return 2.5;
  if (spot >= 20) return 1;
  return 0.5;
}

/** Parameters of the fixture's volatility surface. Exported for tests to assert against. */
export interface FixtureSurface {
  /** ATM volatility at the 30-day tenor. */
  atmIv: number;
  /** Skew slope: IV added per unit of log-moneyness. Negative ⇒ put skew. */
  skewSlope: number;
  /** Smile curvature: IV added per unit of squared log-moneyness. */
  smileCurvature: number;
  /** Term-structure slope: IV added per unit of sqrt(years). */
  termSlope: number;
}

/**
 * The volatility surface a fixture ticker is priced from.
 *
 * @param ticker - The underlying.
 * @returns The surface parameters, deterministic in `ticker`.
 */
export function fixtureSurface(ticker: string): FixtureSurface {
  const s = seed(ticker);
  return {
    atmIv: 0.16 + s * 0.24, // 16% – 40%
    skewSlope: -0.22 - s * 0.18, // steeper put skew for higher-vol names
    smileCurvature: 0.35 + s * 0.3,
    termSlope: 0.04 - s * 0.06, // mostly contango, sometimes inverted
  };
}

/**
 * Evaluate the fixture surface.
 *
 * @param surface - The ticker's surface.
 * @param spot - Underlying price.
 * @param strike - The strike to evaluate at.
 * @param t - Time to expiry in years.
 * @returns The implied volatility at that strike and tenor.
 */
export function surfaceIv(
  surface: FixtureSurface,
  spot: number,
  strike: number,
  t: number,
): number {
  const m = Math.log(strike / spot); // log-moneyness: negative below spot
  const iv =
    surface.atmIv +
    surface.skewSlope * m +
    surface.smileCurvature * m * m +
    surface.termSlope * (Math.sqrt(t) - Math.sqrt(30 / 365));
  return Math.max(0.03, iv);
}

/** Deterministic fixture spot, in a plausible range per ticker. */
export function fixtureSpot(ticker: string): number {
  const s = seed(ticker);
  const raw = 25 + s * 475;
  return Math.round(raw * 100) / 100;
}

/** Every standard monthly (3rd Friday) expiration in the next `months` months. */
export function standardMonthlies(now: Date, months: number): Date[] {
  const out: Date[] = [];
  for (let i = 0; i <= months; i += 1) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + i;
    // Walk the 15th-21st window; exactly one of those days is a Friday.
    for (let d = 15; d <= 21; d += 1) {
      const candidate = new Date(Date.UTC(y, m, d));
      if (isStandardMonthly(candidate) && candidate.getTime() > now.getTime()) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Build one contract, priced through Black-Scholes from the surface. */
function buildContract(
  ticker: string,
  right: OptionRight,
  spot: number,
  strike: number,
  expiration: string,
  dte: number,
  surface: FixtureSurface,
  rate: number,
): HedgeContract {
  const t = yearsToExpiry(dte);
  const sigma = surfaceIv(surface, spot, strike, t);
  const inputs = { s: spot, k: strike, t, r: rate, q: 0, sigma };
  const mid = price(inputs, right);
  const d = Math.abs(delta(inputs, right));

  // Spread widens as the contract goes out of the money and gets illiquid,
  // exactly where the collar scanner's liquidity penalties need to bite.
  const relSpread = Math.min(0.5, 0.02 + (1 - d) * 0.06);
  const halfSpread = Math.max(0.01, (mid * relSpread) / 2);
  const bid = Math.max(0, round2(mid - halfSpread));
  const ask = round2(mid + halfSpread);

  // Liquidity peaks at the money and decays into the wings.
  const liquidity = Math.exp(-8 * (d - 0.5) ** 2);
  const openInterest = Math.round(200 + liquidity * 9800);
  const volume = Math.round(liquidity * 1500);

  const pad = (n: number) => String(Math.round(n * 1000)).padStart(8, "0");
  const ymd = expiration.replace(/-/g, "").slice(2);
  return {
    contractSymbol: `${ticker}${ymd}${right === "call" ? "C" : "P"}${pad(strike)}`,
    right,
    strike,
    expiration,
    bid,
    ask,
    lastPrice: round2(mid),
    // Deliberately *not* the true surface IV: the real Yahoo field is derived
    // from a stale last price, and a fixture that hands back a perfect IV would
    // hide any bug in the code that prefers a solved IV over the provider's.
    impliedVolatility: round2(sigma * 0.97 * 100) / 100,
    volume,
    openInterest,
    lastTradeDate: null,
    inTheMoney: right === "call" ? strike < spot : strike > spot,
  };
}

/**
 * Build a full deterministic chain snapshot.
 *
 * @param ticker - The underlying.
 * @param now - Capture instant.
 * @param targetDtes - Tenors to build, mirroring `chain.targetDte`.
 * @param rate - Risk-free rate used for pricing.
 * @returns A snapshot with the same shape a live provider returns.
 */
export function fixtureChainSnapshot(
  ticker: string,
  now: Date,
  targetDtes: readonly number[] = [30, 90, 180],
  rate = 0.042,
): ChainSnapshot {
  const spot = fixtureSpot(ticker);
  const surface = fixtureSurface(ticker);
  const step = strikeStep(spot);
  const monthlies = standardMonthlies(now, 13);

  // A wide ladder (±40%) is what makes a 25-delta strike reachable at all — the
  // thin ±10% ladder a weekly lists is precisely the trap this avoids.
  const strikes: number[] = [];
  const lo = Math.ceil((spot * 0.6) / step) * step;
  const hi = Math.floor((spot * 1.4) / step) * step;
  for (let k = lo; k <= hi; k += step) strikes.push(round2(k));

  const expiries: HedgeExpiry[] = [];
  for (const target of targetDtes) {
    let best = monthlies[0];
    if (!best) continue;
    for (const d of monthlies) {
      const dte = Math.round((d.getTime() - now.getTime()) / 86_400_000);
      const bestDte = Math.round((best.getTime() - now.getTime()) / 86_400_000);
      if (Math.abs(dte - target) < Math.abs(bestDte - target)) best = d;
    }
    const expiration = toIsoDate(best);
    if (expiries.some((e) => e.expiration === expiration)) continue;

    const dte = Math.round((best.getTime() - now.getTime()) / 86_400_000);
    expiries.push({
      expiration,
      dte,
      standardMonthly: true,
      targetDte: target,
      calls: strikes.map((k) =>
        buildContract(ticker, "call", spot, k, expiration, dte, surface, rate),
      ),
      puts: strikes.map((k) =>
        buildContract(ticker, "put", spot, k, expiration, dte, surface, rate),
      ),
    });
  }

  return {
    ticker: ticker.toUpperCase(),
    capturedAt: new Date(now).toISOString(),
    spot,
    availableExpirations: monthlies.map(toIsoDate),
    expiries: expiries.sort((a, b) => a.dte - b.dte),
    events: { earningsDate: null, exDividendDate: null },
    source: "fixture",
    fallback: true,
  };
}
