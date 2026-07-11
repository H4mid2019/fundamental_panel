/**
 * Scanner registry — run the per-ticker scanners and rank their output.
 *
 * A scanner never throws: it returns `null` when a ticker does not qualify. One
 * bad ticker must never take down the ranking for the other eighty-four.
 */

import { logger } from "../../logger";
import type { HedgeConfig } from "../config";

import { callCreditScanner } from "./callCredit";
import { collarScanner } from "./collar";
import { protectivePutScanner } from "./protectivePut";
import { putDebitSpreadScanner } from "./putDebitSpread";
import {
  SCANNER_IDS,
  type ScanContext,
  type Scanner,
  type ScannerId,
  type Setup,
} from "./types";

export * from "./types";
export { computeTailHedgeSignal, buildTailHedgeSetup } from "./tailHedge";
export type { TailHedgeContext, TailHedgeSignal } from "./tailHedge";

/**
 * The per-ticker scanners.
 *
 * The tail-hedge monitor is deliberately absent: it is a market-regime detector
 * that needs cross-ticker context (the VIX curve, credit spreads, SPY's skew), so
 * the orchestrator runs it once for the whole scan rather than per ticker.
 */
const SCANNERS: Scanner[] = [
  protectivePutScanner,
  putDebitSpreadScanner,
  callCreditScanner,
  collarScanner,
];

/**
 * Run every enabled per-ticker scanner over one ticker.
 *
 * @param ctx - The ticker's metrics, surface and dividend profile.
 * @returns Zero or more setups. Never throws.
 */
export function runScanners(ctx: ScanContext): Setup[] {
  const out: Setup[] = [];
  for (const scanner of SCANNERS) {
    try {
      const setup = scanner.run(ctx);
      if (setup) out.push(setup);
    } catch (error) {
      // A scanner is pure math over a validated surface, so this is a bug, not a
      // data problem — but it still must not cost us the rest of the board.
      logger.error("hedge.scanner threw", {
        scanner: scanner.id,
        ticker: ctx.metrics.ticker,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

/** Setups grouped by scanner, each sorted best-first and capped at `topN`. */
export type RankedSetups = Record<ScannerId, Setup[]>;

/**
 * Group, sort and truncate the whole scan's setups.
 *
 * @param setups - Every setup produced this scan.
 * @param config - Supplies `scanners.topN`.
 * @returns The ranked board.
 */
export function rankSetups(
  setups: readonly Setup[],
  config: HedgeConfig,
): RankedSetups {
  const ranked = Object.fromEntries(
    SCANNER_IDS.map((id) => [id, [] as Setup[]]),
  ) as RankedSetups;

  for (const s of setups) ranked[s.scanner].push(s);

  for (const id of SCANNER_IDS) {
    ranked[id].sort((a, b) => b.score - a.score);
    ranked[id] = ranked[id].slice(0, config.scanners.topN);
  }
  return ranked;
}
