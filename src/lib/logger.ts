// This module is the single sanctioned console sink; `no-console` is disabled
// for this file via eslint.config.mjs.

type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: LogLevel =
  process.env.NODE_ENV === "production" ? "info" : "debug";

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function emit(level: LogLevel, message: string, context?: LogContext): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[MIN_LEVEL]) return;

  const record = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(context
      ? {
          context: Object.fromEntries(
            Object.entries(context).map(([k, v]) => [k, serialize(v)]),
          ),
        }
      : {}),
  };

  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Structured JSON logger. The only place in `src/` permitted to touch the
 * console. Each method emits a single JSON line for ingestion by log tooling.
 */
export const logger = {
  /** Log fine-grained diagnostic detail (suppressed in production). */
  debug: (message: string, context?: LogContext): void =>
    emit("debug", message, context),
  /** Log a normal, expected event. */
  info: (message: string, context?: LogContext): void =>
    emit("info", message, context),
  /** Log a recoverable problem worth attention. */
  warn: (message: string, context?: LogContext): void =>
    emit("warn", message, context),
  /** Log an error condition. */
  error: (message: string, context?: LogContext): void =>
    emit("error", message, context),
} as const;
