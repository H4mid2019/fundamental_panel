import { err, ok, type AppError, type Result } from "./types";

const DEFAULT_TIMEOUT_MS = 8000;

interface FetchJsonOptions {
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
  /** Optional request init forwarded to `fetch`. */
  init?: RequestInit;
}

/**
 * Fetch JSON with a timeout, returning a {@link Result} instead of throwing.
 *
 * @param url - The absolute URL to request.
 * @param options - Optional timeout and `fetch` init.
 * @returns `ok` with the parsed JSON, or `err` describing the failure.
 */
export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<Result<T, AppError>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return err({
        code: response.status === 404 ? "NOT_FOUND" : "PROVIDER_ERROR",
        message: `Request to ${redact(url)} failed with ${response.status}`,
      });
    }
    const data = (await response.json()) as T;
    return ok(data);
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return err({
      code: isAbort ? "UPSTREAM_TIMEOUT" : "PROVIDER_ERROR",
      message: isAbort
        ? `Request to ${redact(url)} timed out after ${timeoutMs}ms`
        : `Request to ${redact(url)} threw: ${String(error)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Strip query strings (which may carry API keys) from a URL for logging. */
function redact(url: string): string {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.slice(0, idx);
}
