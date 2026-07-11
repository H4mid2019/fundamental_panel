/**
 * `PolygonProvider` — stub.
 *
 * Polygon's options snapshot endpoint returns greeks, IV, open interest and the
 * NBBO quote per contract, and — unlike Yahoo — can return every expiration in
 * one paginated call rather than one HTTP round-trip per tenor. That would make
 * `chain.targetDte` a filter rather than a call budget, and largely retire the
 * backoff machinery in `providers/yahoo.ts`.
 *
 * As with {@link ../tradier}, the value of the stub is the contract: it satisfies
 * {@link ChainProvider}, so a paid feed can be swapped in without the metrics
 * layer noticing.
 */

import { err, type AppError, type Result } from "../../types";
import type { ChainSnapshot } from "../types";

import type { ChainProvider, ChainRequest } from "./types";

/** Not-yet-implemented Polygon chain provider. */
export class PolygonProvider implements ChainProvider {
  readonly name = "polygon";

  /**
   * Capture a chain snapshot.
   *
   * @param request - Ticker and target tenors.
   * @returns Always a `PROVIDER_ERROR` until implemented.
   */
  async getChainSnapshot(
    request: ChainRequest,
  ): Promise<Result<ChainSnapshot, AppError>> {
    return err({
      code: "PROVIDER_ERROR",
      message: `PolygonProvider is not implemented (requested ${request.ticker})`,
    });
  }
}
