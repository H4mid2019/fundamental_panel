/**
 * Server bootstrap. Next calls `register()` exactly once when a server instance
 * starts, before it handles any request.
 *
 * This is where HedgeScope's scan scheduler is started. It is guarded twice: once
 * on the runtime (the Edge runtime has no timers, no filesystem and no SQLite, so
 * importing the scheduler there would fail at module load), and once inside the
 * scheduler itself by a Redis lock, so that multiple workers or a separate scanner
 * container cannot double-fire the same scan.
 *
 * The import is dynamic and deliberately so: a static import would pull `node:sqlite`
 * and `node-cron` into the Edge bundle even though the guard would stop them
 * running.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { logger } = await import("./lib/logger");

  try {
    const { startScheduler } = await import("./lib/hedge/scheduler");
    const started = startScheduler();
    logger.info("instrumentation: hedge scheduler registered", {
      tasks: started,
    });
  } catch (error) {
    // A broken scheduler must not stop the server from serving `/` and `/chart`.
    // The dashboard degrades to whatever the last successful scan wrote, and the
    // manual scan endpoint still works.
    logger.error("instrumentation: could not start the hedge scheduler", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
