/**
 * The scan scheduler.
 *
 * Started once from `instrumentation.ts` when the Node server boots. Two things
 * make it safe:
 *
 *  1. **Timezone-aware cron.** The schedule is "30 minutes after the US open" and
 *     "30 minutes before the close", which in UTC is a different wall-clock time in
 *     summer than in winter. `node-cron` is given `America/New_York` and handles
 *     the DST transition; hardcoding UTC offsets would silently drift by an hour
 *     twice a year and scan the wrong part of the session.
 *
 *  2. **A Redis lock.** Next can boot more than one worker, and the escape hatch
 *     for a heavy scan is a *second container* running the same image. Either way
 *     two processes could hold a cron timer that fires at the same instant. The
 *     lock means exactly one of them actually scans — the rest see the lock held
 *     and return. Its TTL is the safety net: a crash mid-scan expires the lock
 *     rather than wedging the scheduler forever.
 */

import cron, { type ScheduledTask } from "node-cron";

import { releaseLock, tryAcquireLock } from "../cache";
import { env } from "../env";
import { logger } from "../logger";

import { getHedgeConfig } from "./config";
import { runScan } from "./scan";

const LOCK_KEY = "hedge:scan:lock";

/**
 * Long enough that a slow 85-ticker scan (~90s, plus AI) never has its lock expire
 * underneath it, short enough that a crashed process does not block the next
 * scheduled scan hours later.
 */
const LOCK_TTL_SECONDS = 20 * 60;

let tasks: ScheduledTask[] = [];

/** Run one scan under the lock, swallowing everything. */
async function scanOnce(): Promise<void> {
  const acquired = await tryAcquireLock(LOCK_KEY, LOCK_TTL_SECONDS);
  if (!acquired) {
    logger.info(
      "hedge.scheduler: another process holds the scan lock; skipping",
    );
    return;
  }

  try {
    const result = await runScan({ trigger: "cron" });
    logger.info("hedge.scheduler: scan complete", {
      scanId: result.scanId,
      status: result.status,
      alerts: result.alerts.length,
    });
  } catch (error) {
    // A scheduled job that throws kills nothing but itself — but it must not take
    // the server's boot sequence or the next tick with it.
    logger.error("hedge.scheduler: scan failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await releaseLock(LOCK_KEY);
  }
}

/**
 * Start the cron scheduler.
 *
 * Idempotent: calling it twice replaces the existing tasks rather than doubling
 * them, which matters in dev where the module can be re-evaluated on HMR.
 *
 * @returns The number of cron expressions registered.
 */
export function startScheduler(): number {
  const config = getHedgeConfig();
  const { schedule } = config;

  stopScheduler();

  if (!schedule.enabled) {
    logger.info("hedge.scheduler: disabled in hedge.config.yaml");
    return 0;
  }

  // A container set to role `web` serves requests only; the scanner role (or the
  // default `all`) owns the cron loop.
  if (env.HEDGE_ROLE === "web") {
    logger.info("hedge.scheduler: HEDGE_ROLE=web; not starting the scan loop");
    return 0;
  }

  for (const expression of schedule.crons) {
    if (!cron.validate(expression)) {
      // A malformed cron would silently never fire, which is the worst outcome:
      // the dashboard looks alive and simply stops updating.
      logger.error("hedge.scheduler: invalid cron expression; skipping", {
        expression,
      });
      continue;
    }

    const task = cron.schedule(expression, () => void scanOnce(), {
      timezone: schedule.timezone,
    });
    tasks.push(task);
  }

  logger.info("hedge.scheduler: started", {
    crons: schedule.crons,
    timezone: schedule.timezone,
    role: env.HEDGE_ROLE,
  });
  return tasks.length;
}

/** Stop every scheduled task. */
export function stopScheduler(): void {
  for (const task of tasks) {
    void task.destroy();
  }
  tasks = [];
}
