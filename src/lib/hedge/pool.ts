/**
 * A bounded-concurrency map.
 *
 * `Promise.all` over a 60-ticker universe would open 60 simultaneous Yahoo
 * connections and get the scan rate-limited within seconds. This runs at most
 * `limit` tasks at a time while preserving result order.
 */

/**
 * Map over `items` with at most `limit` tasks in flight.
 *
 * The worker is expected not to reject — every HedgeScope provider returns a
 * `Result` instead — but a rejection is still contained: it resolves to `null`
 * for that item so one bad ticker can never abort the scan over the other 59.
 *
 * @param items - The inputs.
 * @param limit - Maximum concurrent tasks (coerced to at least 1).
 * @param worker - Async function applied to each item.
 * @returns Results in input order; `null` where the worker threw.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array<R | null>(items.length).fill(null);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await worker(item, index);
      } catch {
        results[index] = null;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, run));
  return results;
}
