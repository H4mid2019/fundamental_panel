/**
 * The chain-snapshot job: capture every ticker in the universe and persist the
 * raw chains.
 *
 * The governing rule is that a scan is *never* all-or-nothing. Yahoo has no chain
 * for some symbols, throws for others, and rate-limits under load; a universe of
 * 60+ tickers will always have a few casualties. So every ticker is captured
 * independently, a failure is recorded as a {@link SkippedTicker} with a reason
 * and logged loudly, and the scan finishes `partial` rather than `failed`.
 */

import { logger } from "../logger";

import { getHedgeConfig } from "./config";
import type { HedgeDb } from "./db/client";
import {
  finishScan,
  insertChainSnapshot,
  startScan,
  type ScanTrigger,
} from "./db/repo";
import { mapWithConcurrency } from "./pool";
import type { ChainProvider } from "./providers/types";
import { YahooChainProvider } from "./providers/yahoo";
import type {
  ChainSnapshot,
  SkipReason,
  SkippedTicker,
  SnapshotRun,
} from "./types";

/** Map an AppError code onto the reason recorded against a skipped ticker. */
function skipReason(code: string): SkipReason {
  return code === "NOT_FOUND" ? "no_chain" : "provider_error";
}

/** Build the default provider from config. */
export function defaultChainProvider(): ChainProvider {
  const { chain } = getHedgeConfig();
  return new YahooChainProvider({
    maxRetries: chain.maxRetries,
    jitterMs: [chain.jitterMs[0], chain.jitterMs[1]],
    cacheTtlSeconds: chain.cacheTtlSeconds,
  });
}

/** Everything the snapshot job needs; all injectable so tests need no network. */
export interface SnapshotOptions {
  trigger: ScanTrigger;
  /** Defaults to the configured universe. */
  tickers?: readonly string[];
  provider?: ChainProvider;
  db?: HedgeDb;
  /** Capture instant, injected for determinism. */
  now?: Date;
  /** Persist raw chains. Set false to compute without writing (dry runs). */
  persist?: boolean;
}

/**
 * Capture chain snapshots for the whole universe and persist them.
 *
 * Opens a `scans` row, captures each ticker under a concurrency cap, gzips and
 * stores every successful chain, and closes the scan out as `ok` (nothing
 * skipped), `partial` (some skipped) or `failed` (nothing captured at all).
 *
 * @param options - Trigger, and any injected collaborators.
 * @returns The scan id, the captured snapshots and the skipped tickers.
 */
export async function runChainSnapshot(
  options: SnapshotOptions,
): Promise<SnapshotRun> {
  const config = getHedgeConfig();
  const tickers = options.tickers ?? config.universe;
  const provider = options.provider ?? defaultChainProvider();
  const now = options.now ?? new Date();
  const persist = options.persist ?? true;

  const scanId = startScan(options.trigger, options.db);
  logger.info("hedge.snapshot.start", {
    scanId,
    trigger: options.trigger,
    tickers: tickers.length,
    provider: provider.name,
    concurrency: config.chain.concurrency,
  });

  const snapshots: ChainSnapshot[] = [];
  const skipped: SkippedTicker[] = [];
  let bytes = 0;

  try {
    const captured = await mapWithConcurrency(
      tickers,
      config.chain.concurrency,
      async (ticker) => {
        const result = await provider.getChainSnapshot({
          ticker,
          tenors: config.chain.tenors,
          minDte: config.chain.minDte,
          now,
        });

        if (!result.ok) {
          return {
            ticker,
            reason: skipReason(result.error.code),
            detail: result.error.message,
          } satisfies SkippedTicker;
        }

        // A chain without a spot price cannot anchor a strike ladder, so every
        // moneyness- and delta-based metric downstream would be meaningless.
        // Better to skip it than to emit numbers computed against `null`.
        if (result.data.spot === null) {
          return {
            ticker,
            reason: "no_spot",
            detail: "provider returned no underlying price",
          } satisfies SkippedTicker;
        }

        return result.data;
      },
    );

    for (const entry of captured) {
      // `null` means the worker itself threw — a provider that broke its own
      // never-throw contract. Contain it rather than losing the scan.
      if (entry === null) {
        skipped.push({
          ticker: "(unknown)",
          reason: "provider_error",
          detail: "provider threw instead of returning a Result",
        });
        continue;
      }
      if ("reason" in entry) {
        skipped.push(entry);
        continue;
      }
      snapshots.push(entry);
      if (persist) bytes += insertChainSnapshot(scanId, entry, options.db);
    }

    for (const s of skipped) {
      logger.warn("hedge.snapshot.skipped", {
        scanId,
        ticker: s.ticker,
        reason: s.reason,
        detail: s.detail,
      });
    }

    const status =
      snapshots.length === 0 ? "failed" : skipped.length > 0 ? "partial" : "ok";

    finishScan(
      scanId,
      {
        status,
        tickersOk: snapshots.length,
        tickersFailed: skipped.length,
        ...(snapshots.length === 0
          ? { error: "no ticker produced a usable chain" }
          : {}),
      },
      options.db,
    );

    logger.info("hedge.snapshot.done", {
      scanId,
      status,
      ok: snapshots.length,
      skipped: skipped.length,
      compressedBytes: bytes,
    });

    return { scanId, snapshots, skipped };
  } catch (error) {
    // Anything that escapes here is a bug (a DB write failing, say), not a bad
    // ticker. Close the scan row out so it never sits `running` forever.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("hedge.snapshot.failed", { scanId, error: message });
    finishScan(
      scanId,
      {
        status: "failed",
        tickersOk: snapshots.length,
        tickersFailed: skipped.length,
        error: message,
      },
      options.db,
    );
    throw error;
  }
}
