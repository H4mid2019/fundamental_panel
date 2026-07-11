/**
 * `TradierProvider` — stub.
 *
 * Tradier is the natural upgrade from Yahoo: its `/v1/markets/options/chains`
 * endpoint returns the whole chain for an expiration in one call *with* greeks
 * and a real bid/ask, which would let `metrics/` drop the local IV inversion and
 * trust the feed's own delta.
 *
 * The point of this file existing today is the contract: it implements
 * {@link ChainProvider}, so wiring it up is a one-line change in the scan
 * orchestrator's provider selection and touches no metric, scanner or route.
 * Implementing it means filling in `getChainSnapshot` and adding
 * `TRADIER_API_KEY` to `src/lib/env.ts` — nothing else.
 */

import { err, type AppError, type Result } from "../../types";
import type { ChainSnapshot } from "../types";

import type { ChainProvider, ChainRequest } from "./types";

/** Not-yet-implemented Tradier chain provider. */
export class TradierProvider implements ChainProvider {
  readonly name = "tradier";

  /**
   * Capture a chain snapshot.
   *
   * @param request - Ticker and target tenors.
   * @returns Always a `PROVIDER_ERROR` until implemented — following the house
   *   rule that a provider reports failure rather than throwing, so a
   *   mis-configured feed degrades to a skipped ticker instead of a dead scan.
   */
  async getChainSnapshot(
    request: ChainRequest,
  ): Promise<Result<ChainSnapshot, AppError>> {
    return err({
      code: "PROVIDER_ERROR",
      message: `TradierProvider is not implemented (requested ${request.ticker})`,
    });
  }
}
