/**
 * HedgeScope domain types.
 *
 * Deliberately separate from the dashboard's `OptionContract`/`OptionsChain` in
 * `src/lib/types.ts`. That pair is shaped for the `/` options panel: it windows
 * the chain to the 21 strikes nearest spot and drops bid/ask, which is exactly
 * right for an IV-smile chart and exactly wrong here — 25-delta strike selection
 * needs the *whole* chain, and the collar scanner's liquidity penalties need the
 * two-sided market. Widening the shared type would have changed what `/` renders,
 * so HedgeScope carries its own.
 */

/** Which side of the chain a contract sits on. */
export type OptionRight = "call" | "put";

/** A single option contract as captured from a provider, before any filtering. */
export interface HedgeContract {
  /** Provider contract id, e.g. `SPY260821P00700000`. */
  contractSymbol: string;
  right: OptionRight;
  strike: number;
  /** Expiration as `YYYY-MM-DD`. */
  expiration: string;
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  /** The provider's own IV, as a decimal fraction. Often stale — see `metrics/atmIv`. */
  impliedVolatility: number | null;
  volume: number | null;
  openInterest: number | null;
  /** ISO timestamp of the last trade, used to detect stale quotes. */
  lastTradeDate: string | null;
  inTheMoney: boolean;
}

/** Every contract captured for one expiration. */
export interface HedgeExpiry {
  /** Expiration as `YYYY-MM-DD`. */
  expiration: string;
  /** Calendar days from the capture instant to expiration. */
  dte: number;
  /** True when this is a standard monthly (3rd Friday) expiration. */
  standardMonthly: boolean;
  /** The target DTE from `chain.targetDte` that selected this expiration. */
  targetDte: number;
  calls: HedgeContract[];
  puts: HedgeContract[];
}

/** Corporate-event context, absent for ETFs and indices. */
export interface HedgeEvents {
  /** Next earnings date (`YYYY-MM-DD`), or `null` when unknown/not applicable. */
  earningsDate: string | null;
  /** Next ex-dividend date (`YYYY-MM-DD`); drives short-call assignment risk. */
  exDividendDate: string | null;
}

/** A full multi-expiry chain snapshot for one underlying at one instant. */
export interface ChainSnapshot {
  ticker: string;
  /** ISO timestamp of capture. */
  capturedAt: string;
  spot: number | null;
  /** Every expiration the provider listed, whether or not it was captured. */
  availableExpirations: string[];
  /** The expirations actually captured, one per configured target tenor. */
  expiries: HedgeExpiry[];
  events: HedgeEvents;
  /** Provider that produced this snapshot. */
  source: string;
  /** True when produced from deterministic fixtures rather than live data. */
  fallback: boolean;
}

/** Why a ticker produced no usable snapshot. */
export type SkipReason =
  | "no_chain" // provider lists no expirations (e.g. ^TNX)
  | "no_spot" // no underlying price to anchor strikes against
  | "no_expiry_in_range" // nothing at or beyond `chain.minDte`
  | "provider_error";

/** A ticker the scan could not snapshot, and why. Never fatal to the scan. */
export interface SkippedTicker {
  ticker: string;
  reason: SkipReason;
  detail: string;
}

/** The outcome of snapshotting the whole universe. */
export interface SnapshotRun {
  scanId: number;
  snapshots: ChainSnapshot[];
  skipped: SkippedTicker[];
}
