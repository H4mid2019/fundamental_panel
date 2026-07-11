/**
 * The metrics engine: one chain snapshot plus one candle series in, one metrics
 * row out.
 *
 * Pure and synchronous by design — every input is passed in, nothing is fetched
 * here — so the entire quant layer is unit-testable against fixture chains with
 * no network at all.
 */

import type { Candle } from "../../chart/types";
import { computePriceAction } from "../../indicators/priceAction";
import type { HedgeConfig } from "../config";
import type { HistoryRow } from "../db/repo";
import { yearsToExpiry } from "../math/blackScholes";
import { atmIvAtTenor, type TenorPoint } from "../math/interpolation";
import type { DataQuality } from "../math/parity";
import {
  correlation,
  logReturns,
  percentileRank,
  rangeRank,
  realizedVolatility,
  zScore,
} from "../math/stats";
import type { ChainSnapshot } from "../types";

import { buildSurface, readSkew, type RateContext } from "./surface";
import { computeVrp } from "./vrp";

/** Everything the engine needs about one ticker. */
export interface MetricsInput {
  snapshot: ChainSnapshot;
  /** Daily candles for the underlying, oldest first. */
  candles: readonly Candle[];
  /** Daily candles for the correlation benchmark (SPY), oldest first. */
  benchmarkCandles: readonly Candle[];
  /** Rate environment used for every delta and parity check. */
  rates: RateContext;
  /** This ticker's trailing observation series, oldest first. */
  history: readonly HistoryRow[];
  /** Count of genuine (non-proxied) ATM IV observations. */
  realIvDays: number;
}

/** One ticker's computed metrics for one scan. */
export interface TickerMetrics {
  ticker: string;
  spot: number;

  // ── A1: the rate environment the deltas were computed in ──
  riskFreeRate: number;
  dividendYield: number;
  /** True when r or q fell back; every delta below is approximate. */
  ratesFallback: boolean;
  /** The dividend yield implied by the chain's own forward, when recoverable. */
  impliedQ: number | null;

  // ── A2: constant-maturity ATM IV, interpolated in total variance ──
  /** Decimal (0.18 = 18%). `null` when the chain did not bracket 30 days. */
  atmIv30: number | null;
  atmIv90: number | null;
  atm30Bracketed: boolean;

  // ── IV rank / percentile (proxied until the history matures) ──
  ivRank: number | null;
  ivPercentile: number | null;
  ivRankProxied: boolean;
  ivHistoryDays: number;

  // ── skew, all in vol points ──
  putSkew25d: number | null;
  putSkewZ: number | null;
  callPutSpread: number | null;
  callPutSpreadZ: number | null;
  skew25dBracketed: boolean;
  /**
   * Whether `putSkewZ` is measured against this ticker's own history
   * (`time_series`) or against the universe today (`cross_sectional`). They
   * answer different questions; see `fillCrossSectionalSkewZ`.
   */
  skewZBasis: "time_series" | "cross_sectional" | null;
  put25Strike: number | null;
  call25Strike: number | null;

  // ── term structure ──
  /** ATM_IV_90d - ATM_IV_30d, in vol points. Negative = inverted. */
  termSlope: number | null;
  termSlopeZ: number | null;
  termInverted: boolean;
  frontDte: number | null;

  // ── B4/B5 ──
  ewmaVol: number | null;
  realizedVol20d: number | null;
  vrp: number | null;
  vrpZ: number | null;
  vrpState: "rich" | "fair" | "cheap" | "unknown";

  // ── price context (reuses indicators/priceAction) ──
  pctVs200dma: number | null;
  pctFrom52wHigh: number | null;
  pctFrom52wLow: number | null;
  rsi14: number | null;

  // ── correlation ──
  corrSpy60d: number | null;

  // ── events ──
  earningsDate: string | null;
  exDividendDate: string | null;
  earningsInFrontWindow: boolean;

  // ── B6 ──
  contractsTotal: number;
  contractsExcluded: number;
  parityViolations: number;
  dataQuality: DataQuality;
}

/** Pull one column out of a history series, dropping nulls. */
function column(
  history: readonly HistoryRow[],
  key: keyof HistoryRow,
): number[] {
  const out: number[] = [];
  for (const row of history) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Closes from a candle series. */
const closesOf = (candles: readonly Candle[]): number[] =>
  candles.map((c) => c.close).filter((c) => Number.isFinite(c) && c > 0);

/**
 * Compute every metric for one ticker.
 *
 * @param input - The snapshot, candles, rates and history.
 * @param config - Thresholds and lookbacks.
 * @returns The metrics row, or `null` when the snapshot has no usable surface.
 */
export function computeMetrics(
  input: MetricsInput,
  config: HedgeConfig,
): TickerMetrics | null {
  const { snapshot, candles, benchmarkCandles, rates, history, realIvDays } =
    input;

  const surface = buildSurface(snapshot, rates, config);
  if (!surface) return null;

  const { metrics: cfg } = config;

  // ── A2: constant-maturity ATM IV via total-variance interpolation ──
  const tenorPoints: TenorPoint[] = surface.expiries
    .filter((e): e is typeof e & { atmIv: number } => e.atmIv !== null)
    .map((e) => ({ t: e.t, iv: e.atmIv }));

  const atmIv30 = atmIvAtTenor(tenorPoints, yearsToExpiry(30));
  const atmIv90 = atmIvAtTenor(tenorPoints, yearsToExpiry(90));

  // Term slope in vol points. Never from raw captured expiries — those sit at
  // whatever DTE the calendar happened to offer, so their difference would drift
  // with the expiry cycle rather than reflect the surface.
  const termSlope =
    atmIv30 !== null && atmIv90 !== null ? (atmIv90 - atmIv30) * 100 : null;

  // ── Skew, from the front standard monthly only ──
  const skewExpiry = surface.expiries.find(
    (e) => e.usableForSkew && e.dte >= 30,
  );
  const skew = skewExpiry ? readSkew(skewExpiry) : null;

  // ── B4/B5 ──
  const closes = closesOf(candles);
  const returns = logReturns(closes);
  const realizedVol20d = realizedVolatility(returns, cfg.realizedVolWindowDays);

  const vrpHistory = column(history, "vrp");
  const vrpReading = computeVrp(atmIv30, closes, cfg.ewmaLambda, vrpHistory);

  // ── IV rank / percentile ──
  //
  // The series is `history.atm_iv`, which since migration 2 is specifically the
  // constant-maturity 30d ATM IV — so the rank compares like with like instead of
  // ranking whatever tenor the calendar happened to serve up that day.
  //
  // Below `ivRankMinRealDays` genuine observations, there is no IV history worth
  // ranking against, so the rank falls back to a realized-volatility rank. It is
  // then flagged `proxied` everywhere it surfaces: on day one "IV rank" is really
  // realized-vol rank, and it gates two scanners, so it must say so out loud.
  const proxied = realIvDays < cfg.ivRankMinRealDays;

  const ivSeries = proxied
    ? column(history, "realizedVol20d")
    : column(history, "atmIv");
  const ivCurrent = proxied
    ? realizedVol20d
    : atmIv30 !== null
      ? atmIv30 * 100
      : null;

  const lookback = ivSeries.slice(-cfg.ivRankLookbackDays);
  const ivRank =
    ivCurrent !== null && lookback.length >= 2
      ? rangeRank(ivCurrent, lookback)
      : null;
  const ivPercentile =
    ivCurrent !== null && lookback.length >= 2
      ? percentileRank(ivCurrent, lookback)
      : null;

  // ── z-scores against each metric's own history ──
  const zOf = (value: number | null, key: keyof HistoryRow): number | null => {
    if (value === null) return null;
    const series = column(history, key).slice(-cfg.skewZLookbackDays);
    return series.length >= 20 ? zScore(value, series) : null;
  };

  const skewZ = zOf(skew?.putSkew ?? null, "putSkew25d");

  // ── Price context: reuse the existing indicator, do not reimplement it ──
  const priceAction = computePriceAction(candles);

  // ── Correlation vs the benchmark, on forward-filled-aligned returns ──
  const benchCloses = closesOf(benchmarkCandles);
  const benchReturns = logReturns(benchCloses);
  const window = cfg.correlationWindowDays;
  const corrSpy60d =
    returns.length >= window && benchReturns.length >= window
      ? correlation(returns.slice(-window), benchReturns.slice(-window))
      : null;

  // ── Events ──
  const frontDte = surface.expiries[0]?.dte ?? null;
  const earningsDate = snapshot.events.earningsDate;
  const earningsInFrontWindow =
    earningsDate !== null && frontDte !== null
      ? (() => {
          const days = Math.round(
            (Date.parse(earningsDate) - Date.parse(snapshot.capturedAt)) /
              86_400_000,
          );
          return days >= 0 && days <= frontDte;
        })()
      : false;

  return {
    ticker: surface.ticker,
    spot: surface.spot,

    riskFreeRate: rates.r,
    dividendYield: rates.q,
    ratesFallback: rates.fallback,
    // From the LONGEST tenor. `q = r - ln(F/S)/T` divides by T, so any staleness
    // in spot is amplified by `1/T` — on a 40-day expiry a 0.2% spot drift becomes
    // a ~2% error in q. The long end is where the number is actually meaningful.
    impliedQ:
      [...surface.expiries].reverse().find((e) => e.impliedQ !== null)
        ?.impliedQ ?? null,

    atmIv30,
    atmIv90,
    atm30Bracketed: atmIv30 !== null,

    ivRank,
    ivPercentile,
    ivRankProxied: proxied,
    ivHistoryDays: realIvDays,

    putSkew25d: skew?.putSkew ?? null,
    putSkewZ: skewZ,
    skewZBasis: skewZ === null ? null : "time_series",
    callPutSpread: skew?.callPutSpread ?? null,
    callPutSpreadZ: zOf(skew?.callPutSpread ?? null, "callPutSpread"),
    skew25dBracketed: skew?.bracketed ?? false,
    put25Strike: skew?.put25Strike ?? null,
    call25Strike: skew?.call25Strike ?? null,

    termSlope,
    termSlopeZ: zOf(termSlope, "termSlope"),
    termInverted: termSlope !== null && termSlope < 0,
    frontDte,

    ewmaVol: vrpReading.ewmaVol,
    realizedVol20d,
    vrp: vrpReading.vrp,
    vrpZ: vrpReading.vrpZ,
    vrpState: vrpReading.state,

    pctVs200dma: priceAction.trendVs200d,
    pctFrom52wHigh: priceAction.from52wHigh,
    pctFrom52wLow: priceAction.from52wLow,
    rsi14: priceAction.rsi14,

    corrSpy60d,

    earningsDate,
    exDividendDate: snapshot.events.exDividendDate,
    earningsInFrontWindow,

    contractsTotal: surface.quality.contractsTotal,
    contractsExcluded: surface.quality.contractsExcluded,
    parityViolations: surface.quality.parityViolations,
    dataQuality: surface.quality.quality,
  };
}

/**
 * Map a computed metrics row into the daily observation row that IV rank and
 * every z-score are later computed against.
 *
 * @param m - The computed metrics.
 * @param asOf - Observation date, `YYYY-MM-DD`.
 * @returns The history row to upsert.
 */
export function toHistoryRow(m: TickerMetrics, asOf: string): HistoryRow {
  const real = m.atmIv30 !== null;
  return {
    ticker: m.ticker,
    asOf,
    close: m.spot,
    // Specifically the constant-maturity 30d ATM IV, in vol points.
    atmIv: real ? (m.atmIv30 ?? 0) * 100 : null,
    // Only a genuine, bracketed ATM IV counts as real history. A proxied value
    // must never mature the IV rank — that would be the proxy quietly
    // certifying itself as the real thing.
    atmIvProxied: !real,
    atmIvBasis: real ? "chain" : "realized_proxy",
    realizedVol20d: m.realizedVol20d,
    putSkew25d: m.putSkew25d,
    callPutSpread: m.callPutSpread,
    termSlope: m.termSlope,
    ewmaVol: m.ewmaVol,
    vrp: m.vrp,
    source: "scan",
  };
}

/**
 * Fill in skew z-scores cross-sectionally for tickers with no history yet.
 *
 * A z-score against a ticker's OWN history answers "is this skew unusual *for
 * this ticker*?". That is the right question — and it needs ~20 accumulated
 * sessions that a fresh install does not have. Unlike implied vol, historical
 * 25-delta skew cannot be backfilled from any free source at all.
 *
 * So until the series fills, skew is z-scored against the **cross-section of the
 * universe today**: "is this skew unusual *versus everything else right now*?".
 * That is a genuinely different, and weaker, question — a name with a
 * structurally steep skew will look extreme every single day, because it always
 * is. It still beats a null by a wide margin, provided nobody can mistake it for
 * the time-series version. Hence every affected row carries
 * `skewZBasis: "cross_sectional"`, and every setup built on one is warned.
 *
 * @param metrics - Every ticker's metrics for this scan. Mutated in place.
 * @returns The same rows, with cross-sectional z-scores filled in where needed.
 */
export function fillCrossSectionalSkewZ(
  metrics: TickerMetrics[],
): TickerMetrics[] {
  const needy = metrics.filter(
    (m) => m.putSkewZ === null && m.putSkew25d !== null,
  );
  const sample = metrics
    .map((m) => m.putSkew25d)
    .filter((v): v is number => v !== null);

  // With a handful of tickers the "cross-section" is not a distribution, it is
  // noise, and a z-score against it means nothing.
  if (needy.length === 0 || sample.length < 8) return metrics;

  for (const m of needy) {
    if (m.putSkew25d === null) continue;
    const z = zScore(m.putSkew25d, sample);
    if (z === null) continue;
    m.putSkewZ = z;
    m.skewZBasis = "cross_sectional";
  }

  return metrics;
}
