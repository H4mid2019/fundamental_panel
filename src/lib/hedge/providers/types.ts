/**
 * The chain-provider contract.
 *
 * The metrics layer consumes {@link ChainSnapshot} and nothing else, so swapping
 * Yahoo for a paid feed (Tradier, Polygon) is a provider swap and touches no
 * metric, scanner or route. Providers follow this codebase's house rule: they
 * never throw — every failure comes back as a `Result`, so one bad ticker can
 * never abort a scan over the other 60.
 */

import type { AppError, Result } from "../../types";
import type { ChainSnapshot } from "../types";

/** What a provider needs in order to capture one underlying. */
export interface ChainRequest {
  ticker: string;
  /** Target tenors in days; the provider snaps each to a real expiration. */
  targetDte: readonly number[];
  /** Never select an expiration closer than this. */
  minDte: number;
  /** Capture instant, injected so snapshots and tests are deterministic. */
  now: Date;
}

/** A source of option-chain snapshots. */
export interface ChainProvider {
  /** Stable id recorded on every snapshot (`yahoo`, `tradier`, ...). */
  readonly name: string;

  /**
   * Capture a full multi-expiry chain for one underlying.
   *
   * @param request - The ticker and tenors to capture.
   * @returns The snapshot, or an {@link AppError} describing why it could not
   *   be captured. Implementations must not throw.
   */
  getChainSnapshot(
    request: ChainRequest,
  ): Promise<Result<ChainSnapshot, AppError>>;
}
