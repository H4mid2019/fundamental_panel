import { Redis } from "@upstash/redis";
import IORedis from "ioredis";
import { LRUCache } from "lru-cache";

import { env, features } from "./env";
import { logger } from "./logger";

/** Abstraction over the cache backend so callers don't care which is active. */
interface CacheBackend {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

/** In-memory LRU backend used when Upstash credentials are absent. */
class MemoryCache implements CacheBackend {
  // LRUCache values must be non-nullable; cached payloads are always objects.
  private readonly store = new LRUCache<string, NonNullable<unknown>>({
    max: 1000,
    ttl: 1000 * 60 * 60, // 1h default ceiling
  });

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T | undefined) ?? null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (value === null || value === undefined) return;
    this.store.set(key, value as unknown as NonNullable<unknown>, {
      ttl: ttlSeconds * 1000,
    });
  }
}

/** Upstash Redis (HTTP REST) backend used when credentials are configured. */
class RedisCache implements CacheBackend {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    return (await this.redis.get<T>(key)) ?? null;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, { ex: ttlSeconds });
  }
}

/** Self-hosted Redis (native protocol) backend via ioredis. */
class IoRedisCache implements CacheBackend {
  constructor(private readonly redis: IORedis) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (value === null || value === undefined) return;
    await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }
}

/**
 * The native Redis client, when one is configured.
 *
 * Exposed only so {@link tryAcquireLock} can issue `SET NX PX`, which the cache
 * abstraction deliberately does not model — a lock is not a cache entry, and
 * conflating them would let a lock be silently evicted under memory pressure.
 */
let ioredisClient: IORedis | null = null;

function createBackend(): CacheBackend {
  if (features.redisUrl && env.REDIS_URL) {
    logger.info("cache.backend", { backend: "redis" });
    const client = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    client.on("error", (error) => logger.warn("redis client error", { error }));
    ioredisClient = client;
    return new IoRedisCache(client);
  }
  if (
    features.redis &&
    env.UPSTASH_REDIS_REST_URL &&
    env.UPSTASH_REDIS_REST_TOKEN
  ) {
    logger.info("cache.backend", { backend: "upstash" });
    return new RedisCache(
      new Redis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      }),
    );
  }
  logger.info("cache.backend", { backend: "memory" });
  return new MemoryCache();
}

const backend: CacheBackend = createBackend();

/**
 * Read a value from the cache.
 *
 * @param key - Cache key.
 * @returns The stored value, or `null` on miss or backend error.
 */
export async function getCached<T>(key: string): Promise<T | null> {
  try {
    return await backend.get<T>(key);
  } catch (error) {
    logger.warn("cache.get failed", { key, error });
    return null;
  }
}

/**
 * Write a value to the cache.
 *
 * @param key - Cache key.
 * @param value - Value to store (must be JSON-serializable).
 * @param ttlSeconds - Time-to-live in seconds.
 */
export async function setCached<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  try {
    await backend.set(key, value, ttlSeconds);
  } catch (error) {
    logger.warn("cache.set failed", { key, error });
  }
}

/**
 * Get a cached value or compute, store and return it on miss.
 *
 * @param key - Cache key.
 * @param ttlSeconds - Time-to-live for freshly computed values.
 * @param compute - Async producer invoked only on cache miss.
 * @returns The cached or freshly computed value.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = await getCached<T>(key);
  if (hit !== null) return hit;
  const value = await compute();
  await setCached(key, value, ttlSeconds);
  return value;
}

/** In-process locks, used when no Redis is configured. */
const memoryLocks = new Map<string, number>();

/**
 * Try to take a mutually-exclusive lock.
 *
 * Backed by Redis `SET NX PX` when `REDIS_URL` is configured, which is what makes
 * it safe across *processes* — the case that matters once the scanner runs in its
 * own container alongside the web one. Without Redis it degrades to an in-process
 * guard, which is still correct for a single-container deployment but cannot see
 * a second process.
 *
 * The TTL is the safety net: if the holder crashes mid-scan, the lock expires
 * rather than wedging the scheduler forever.
 *
 * @param key - Lock name.
 * @param ttlSeconds - How long the lock survives without being released.
 * @returns True when the lock was acquired.
 */
export async function tryAcquireLock(
  key: string,
  ttlSeconds: number,
): Promise<boolean> {
  const client = ioredisClient;
  if (client) {
    try {
      const result = await client.set(key, "1", "PX", ttlSeconds * 1000, "NX");
      return result === "OK";
    } catch (error) {
      logger.warn("lock: redis failed; falling back to in-process", {
        key,
        error,
      });
    }
  }

  const now = Date.now();
  const held = memoryLocks.get(key);
  if (held !== undefined && held > now) return false;
  memoryLocks.set(key, now + ttlSeconds * 1000);
  return true;
}

/**
 * Release a lock taken with {@link tryAcquireLock}.
 *
 * @param key - Lock name.
 */
export async function releaseLock(key: string): Promise<void> {
  memoryLocks.delete(key);
  const client = ioredisClient;
  if (!client) return;
  try {
    await client.del(key);
  } catch (error) {
    logger.warn("lock: redis release failed; it will expire on its own", {
      key,
      error,
    });
  }
}
