/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * Suitable for single-instance deployments and development. In a multi-instance
 * serverless deployment, swap this for an Upstash Redis counter; the interface
 * is intentionally tiny to make that substitution easy.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check and record a hit against a fixed-window limit for a key.
 *
 * @param key - Identifier to bucket by (e.g. an IP address).
 * @param limit - Maximum allowed hits per window.
 * @param windowMs - Window length in milliseconds.
 * @param now - Current time in ms (injectable for testing).
 * @returns Whether the request is allowed plus remaining quota and reset time.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const existing = windows.get(key);
  if (!existing || now >= existing.resetAt) {
    const resetAt = now + windowMs;
    windows.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt };
  }

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
  };
}

/** Clear all rate-limit state (used by tests). */
export function resetRateLimit(): void {
  windows.clear();
}
