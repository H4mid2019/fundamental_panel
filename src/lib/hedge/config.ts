/**
 * HedgeScope configuration: `hedge.config.yaml` → Zod → typed, frozen object.
 *
 * The file is mounted into the container so the universe, schedule and
 * thresholds can be edited without a rebuild. That makes it untrusted input, so
 * it is validated the same way `env.ts` validates `process.env`: parse once at
 * first access and throw a descriptive error on any malformed value rather than
 * letting a typo silently disable a scanner.
 */

import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** A [min, max] pair, validated so `min <= max`. */
const range = (label: string) =>
  z
    .tuple([z.number(), z.number()])
    .refine(([lo, hi]) => lo <= hi, `${label}: min must be <= max`);

const TickerSchema = z
  .string()
  .min(1)
  .max(12)
  .regex(/^[\^A-Za-z0-9.=-]+$/, "Invalid ticker symbol");

const PairSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "Pair id must be kebab-case"),
  numerator: TickerSchema,
  denominator: TickerSchema,
  label: z.string().min(1),
});

const HedgeConfigSchema = z.object({
  universe: z.array(TickerSchema).min(1),

  context: z.object({
    vixTerm: z.array(TickerSchema).min(2),
    rates: z.array(TickerSchema),
    benchmark: TickerSchema,
    tailHedgeUnderlyings: z.array(TickerSchema).min(1),
  }),

  schedule: z.object({
    enabled: z.boolean(),
    timezone: z.string().min(1),
    crons: z.array(z.string().min(1)),
  }),

  chain: z.object({
    /**
     * Two tenor lists, because the wings and the at-the-money point have
     * different requirements.
     *
     * `skew` tenors must resolve to standard monthlies: a 25-delta strike needs
     * a deep strike ladder, and a weekly's is far too shallow to reach one.
     * `term` tenors may resolve to any expiration, weeklies included — ATM
     * strikes are listed on *every* expiry, so ATM IV is safe there. Without a
     * sub-30-day expiry nothing brackets the 30-day point, and a
     * constant-maturity 30d ATM IV (which VRP is defined against) could only be
     * extrapolated.
     */
    tenors: z.object({
      skew: z.array(z.number().int().positive()).min(1),
      term: z.array(z.number().int().positive()),
    }),
    minDte: z.number().int().positive(),
    concurrency: z.number().int().min(1).max(16),
    jitterMs: range("chain.jitterMs"),
    maxRetries: z.number().int().min(0).max(10),
    cacheTtlSeconds: z.number().int().min(0),
    quality: z.object({
      requireTwoSidedQuote: z.boolean(),
      maxRelativeSpread: z.number().positive(),
      minIv: z.number().positive(),
      maxIv: z.number().positive(),
    }),
  }),

  metrics: z.object({
    ivRankLookbackDays: z.number().int().min(2),
    ivRankMinRealDays: z.number().int().min(0),
    skewZLookbackDays: z.number().int().min(2),
    correlationWindowDays: z.number().int().min(2),
    correlationRegimeLookbackDays: z.number().int().min(2),
    realizedVolWindowDays: z.number().int().min(2),

    /**
     * Risk-free rate for Black-Scholes. `irx` reads the 13-week T-bill (^IRX),
     * which is the right maturity for option tenors — ^TNX (10y) is not.
     */
    riskFreeRate: z.object({
      source: z.enum(["irx", "tnx", "fixed"]),
      fallbackRate: z.number().min(0).max(1),
    }),

    /** RiskMetrics EWMA decay. 0.94 is the daily-data standard. */
    ewmaLambda: z.number().gt(0).lt(1),

    /** Trailing window for the VRP z-score. */
    vrpLookbackDays: z.number().int().min(2),

    /**
     * Put-call parity quote-quality guard. A quote is rejected when the parity
     * violation exceeds `max(halfSpreadMult × combined half-spread, tolerance)`.
     * `tolerance` is an absolute floor in dollars, so a zero-width quoted market
     * (which does happen, and is a lie) cannot pass with a zero threshold.
     */
    parity: z.object({
      tolerance: z.number().positive(),
      halfSpreadMult: z.number().positive(),
      /** Below this fraction of usable contracts a ticker is badged `poor`. */
      minGoodFraction: z.number().min(0).max(1),
      /** Above this fraction it is badged `good`; between the two, `degraded`. */
      goodFraction: z.number().min(0).max(1),
    }),
  }),

  pairs: z.object({
    lookbackDays: z.number().int().min(2),
    /**
     * Ornstein-Uhlenbeck mean-reversion guard. A pair z-score is only tradeable
     * if the spread actually mean-reverts; a structurally broken pair diverges
     * forever and a z-score scanner would fade it indefinitely. Half-lives
     * outside this band (or a non-reverting lambda >= 0) mark the pair `fail`.
     */
    minHalfLife: z.number().positive(),
    maxHalfLife: z.number().positive(),
    list: z.array(PairSchema),
  }),

  scanners: z.object({
    topN: z.number().int().min(1).max(100),

    /**
     * How the variance risk premium enters the protective-put and collar
     * rankings.
     *
     * `hardGate: false` (default) uses VRP only as a ranking input, leaving the
     * configured IV-rank thresholds as the sole admission test. Setting it true
     * additionally *excludes* setups on the wrong side of `maxVrpForProtection`
     * — a second opinion bolted onto the thresholds, which is a real change in
     * behaviour and therefore opt-in rather than silent.
     */
    vrp: z.object({
      hardGate: z.boolean(),
      /** Protection is "cheap vs reality" below this VRP, in vol points. */
      maxVrpForProtection: z.number(),
      /** Premium selling is attractive above this VRP, in vol points. */
      minVrpForSelling: z.number(),
      /** Weight of the VRP z-score in the composite ranking score. */
      rankWeight: z.number().min(0),
    }),

    protectivePut: z.object({
      enabled: z.boolean(),
      maxIvRank: z.number().min(0).max(100),
      minPctVs200dma: z.number(),
      otmPctRange: range("scanners.protectivePut.otmPctRange"),
      dteRange: range("scanners.protectivePut.dteRange"),
    }),
    putDebitSpread: z.object({
      enabled: z.boolean(),
      longStrikeOffsetPct: z.number(),
      shortStrikeOffsetPct: z.number(),
      dteRange: range("scanners.putDebitSpread.dteRange"),
      minSkewZ: z.number(),
    }),
    callCredit: z.object({
      enabled: z.boolean(),
      minIvRank: z.number().min(0).max(100),
      minPctVs200dma: z.number(),
      shortDeltaRange: range("scanners.callCredit.shortDeltaRange"),
      wingWidthPct: z.number().positive(),
      dteRange: range("scanners.callCredit.dteRange"),
    }),
    collar: z.object({
      enabled: z.boolean(),
      shortCallDeltaRange: range("scanners.collar.shortCallDeltaRange"),
      longPutDeltaRange: range("scanners.collar.longPutDeltaRange"),
      dteRange: range("scanners.collar.dteRange"),
      penalties: z.object({
        earningsInTenor: z.number().min(0),
        exDivBeforeExpiry: z.number().min(0),
        wideSpread: z.number().min(0),
        thinOpenInterest: z.number().min(0),
      }),
      maxRelativeSpreadPct: z.number().positive(),
      minOpenInterest: z.number().int().min(0),
      /**
       * Early-assignment risk on the short call. A short call is genuinely at
       * risk when its remaining extrinsic value is worth less than the dividend
       * the holder would capture by exercising early:
       *
       *   extrinsic = callMid - max(0, S - K)
       *   at risk when  extrinsic < dividend x exDivBuffer
       *
       * 1.0 is the textbook boundary; raise it to demand a safety margin.
       */
      exDivBuffer: z.number().min(0),
    }),
    tailHedge: z.object({
      enabled: z.boolean(),
      otmPctRange: range("scanners.tailHedge.otmPctRange"),
      dteRange: range("scanners.tailHedge.dteRange"),
      minCompositeScore: z.number(),
    }),
  }),

  alerts: z.object({
    zScoreThreshold: z.number().positive(),
    scannerScoreThreshold: z.number(),
    onTermInversion: z.boolean(),
    onCorrelationRegimeBreak: z.boolean(),
    cooldownDays: z.number().int().min(0),
    fireOnProxiedIvRank: z.boolean(),
  }),

  ai: z.object({
    enabled: z.boolean(),
    topN: z.number().int().min(1).max(50),
  }),
});

/** The validated HedgeScope configuration. */
export type HedgeConfig = z.infer<typeof HedgeConfigSchema>;

/** One configured ratio pair. */
export type PairConfig = z.infer<typeof PairSchema>;

/** Default location, overridable with `HEDGE_CONFIG_PATH` for tests/containers. */
const DEFAULT_CONFIG_PATH = "hedge.config.yaml";

/**
 * Parse and validate a raw YAML document.
 *
 * Exported so tests can exercise validation without touching the filesystem.
 *
 * @param source - The raw YAML text.
 * @param origin - Path shown in the error message.
 * @returns The validated configuration.
 * @throws If the YAML is malformed or fails schema validation.
 */
export function parseHedgeConfig(source: string, origin: string): HedgeConfig {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${origin} as YAML:\n  ${detail}`);
  }

  const parsed = HedgeConfigSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${origin}:\n${issues}`);
  }

  const config = parsed.data;
  const problems: string[] = [];

  if (config.chain.quality.minIv >= config.chain.quality.maxIv) {
    problems.push("chain.quality: minIv must be < maxIv");
  }
  if (config.pairs.minHalfLife >= config.pairs.maxHalfLife) {
    problems.push("pairs: minHalfLife must be < maxHalfLife");
  }
  if (
    config.metrics.parity.minGoodFraction > config.metrics.parity.goodFraction
  ) {
    problems.push("metrics.parity: minGoodFraction must be <= goodFraction");
  }

  // The 30-day point is bracketed only if some tenor resolves below 30 DTE.
  // Without that, a constant-maturity 30d ATM IV — which VRP is defined on —
  // could only be extrapolated, so VRP would be null for every ticker. Catch
  // that here rather than shipping a config that silently disables the metric.
  const tenors = [...config.chain.tenors.skew, ...config.chain.tenors.term];
  if (!tenors.some((t) => t < 30)) {
    problems.push(
      "chain.tenors: needs a tenor below 30 DTE to bracket the 30-day point " +
        "(VRP and the term slope read a constant-maturity 30d ATM IV, and " +
        "extrapolating it is not allowed)",
    );
  }
  if (config.chain.minDte >= 30) {
    problems.push(
      "chain.minDte: must be < 30, or no expiry can bracket the 30-day point",
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid ${origin}:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return config;
}

let cached: HedgeConfig | null = null;

/**
 * Load the HedgeScope config, parsing it at most once per process.
 *
 * @returns The validated configuration.
 * @throws If the file is missing, malformed, or fails validation — deliberately
 *   fatal, so a bad config surfaces at boot instead of mid-scan.
 */
export function getHedgeConfig(): HedgeConfig {
  if (cached) return cached;

  const path = process.env.HEDGE_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  let source: string;
  try {
    // `turbopackIgnore` is load-bearing, not decoration. Turbopack's file tracer
    // sees a filesystem read whose path it cannot resolve statically, assumes
    // the whole project might be needed, and traces *every file in the repo*
    // into the standalone output — silently turning a lean image into a fat one.
    // The path is deliberately dynamic (the container mounts the config, and
    // HEDGE_CONFIG_PATH may be absolute), so the tracer is told to stand down.
    source = readFileSync(/* turbopackIgnore: true */ path, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read HedgeScope config at ${path}:\n  ${detail}`,
    );
  }

  cached = parseHedgeConfig(source, path);
  return cached;
}

/** Drop the memoized config. Test-only; the next read re-parses from disk. */
export function resetHedgeConfig(): void {
  cached = null;
}
