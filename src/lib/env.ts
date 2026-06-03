import { z } from "zod";

/**
 * Server-side environment schema.
 *
 * Provider and AI keys are optional: when one is absent the corresponding
 * module falls back to deterministic fixtures (data providers) or an in-memory
 * LRU cache (Upstash). This keeps local development, CI and the E2E smoke test
 * fully hermetic while still validating the *shape* of any value that is set.
 *
 * Validation runs once at module load. A malformed value (e.g. a non-URL
 * Upstash endpoint) throws immediately — failing fast as required.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_MODEL: z.string().min(1).default("anthropic/claude-3.5-haiku"),

  FMP_API_KEY: z.string().min(1).optional(),
  COINGECKO_API_KEY: z.string().min(1).optional(),
  FRED_API_KEY: z.string().min(1).optional(),
  FINNHUB_API_KEY: z.string().min(1).optional(),

  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),

  // Self-hosted Redis (native protocol), e.g. redis://localhost:6379. Takes
  // precedence over Upstash and the in-memory cache when set.
  REDIS_URL: z.string().min(1).optional(),

  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3000"),

  // When truthy, every provider serves deterministic fixtures (used by E2E).
  USE_FIXTURES: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate `process.env`, throwing a descriptive error on failure.
 *
 * @param source - The raw environment record (defaults to `process.env`).
 * @returns The validated, typed environment object.
 */
export function parseEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  // Treat blank entries (e.g. `KEY=` copied from .env.example) as unset so
  // `.optional()` and `.default()` apply instead of failing validation.
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    normalized[key] =
      typeof value === "string" && value.trim() === "" ? undefined : value;
  }

  const parsed = envSchema.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = parseEnv();

/** Feature flags derived from which credentials are configured. */
export const features = {
  openrouter: Boolean(env.OPENROUTER_API_KEY),
  fmp: Boolean(env.FMP_API_KEY),
  coingecko: Boolean(env.COINGECKO_API_KEY),
  fred: Boolean(env.FRED_API_KEY),
  finnhub: Boolean(env.FINNHUB_API_KEY),
  redisUrl: Boolean(env.REDIS_URL),
  redis: Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN),
  forceFixtures: ["1", "true", "yes"].includes(
    (env.USE_FIXTURES ?? "").toLowerCase(),
  ),
} as const;
