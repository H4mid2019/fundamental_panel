import type { NewsEventType, NewsSentiment } from "../types";

/** A market-event detection rule matched against a headline. */
interface EventRule {
  type: NewsEventType;
  /** Base importance in [0, 1]; higher = more market-moving. */
  weight: number;
  /** Default polarity when no sentiment keyword is present. */
  bias: -1 | 0 | 1;
  /** Lowercased substrings that identify this event type. */
  keywords: string[];
}

/**
 * Ordered event rules. The first rule whose keyword appears in the headline
 * wins, so higher-impact events are listed first.
 */
export const EVENT_RULES: readonly EventRule[] = [
  {
    type: "ma",
    weight: 1,
    bias: 1,
    keywords: [
      "merger",
      "acquire",
      "acquisition",
      "takeover",
      "buyout",
      "to buy",
      "deal to",
      "agrees to buy",
    ],
  },
  {
    type: "leadership",
    weight: 0.9,
    bias: 0,
    keywords: [
      "ceo",
      "chief executive",
      "cfo",
      "resign",
      "steps down",
      "appoints",
      "names new",
      "succession",
      "departs",
      "ousted",
    ],
  },
  {
    type: "legal",
    weight: 0.85,
    bias: -1,
    keywords: [
      "lawsuit",
      "sues",
      "sued",
      "fraud",
      "investigation",
      "probe",
      "charges",
      "antitrust",
      "settlement",
    ],
  },
  {
    type: "regulatory",
    weight: 0.8,
    bias: 0,
    keywords: [
      "regulator",
      "approval",
      "approved",
      "fda",
      "ban",
      "fine",
      "sanction",
      "license",
      "subpoena",
    ],
  },
  {
    type: "earnings",
    weight: 0.75,
    bias: 0,
    keywords: ["earnings", "quarterly results", "q1", "q2", "q3", "q4", "eps"],
  },
  {
    type: "guidance",
    weight: 0.7,
    bias: 0,
    keywords: ["guidance", "forecast", "outlook", "warns", "warning"],
  },
  {
    type: "layoffs",
    weight: 0.65,
    bias: -1,
    keywords: ["layoff", "job cuts", "restructuring", "workforce reduction"],
  },
  {
    type: "analyst",
    weight: 0.55,
    bias: 0,
    keywords: [
      "upgrade",
      "downgrade",
      "price target",
      "rating",
      "overweight",
      "underweight",
      "initiated",
    ],
  },
  {
    type: "partnership",
    weight: 0.55,
    bias: 1,
    keywords: [
      "partnership",
      "partners with",
      "collaboration",
      "joint venture",
    ],
  },
  {
    type: "dividend",
    weight: 0.5,
    bias: 1,
    keywords: ["dividend"],
  },
  {
    type: "buyback",
    weight: 0.5,
    bias: 1,
    keywords: ["buyback", "repurchase", "share repurchase"],
  },
  {
    type: "product",
    weight: 0.5,
    bias: 1,
    keywords: ["launch", "unveils", "new product", "rollout", "releases"],
  },
];

const FALLBACK_WEIGHT = 0.3;

const POSITIVE_WORDS = [
  "beats",
  "surge",
  "soar",
  "record",
  "jumps",
  "rally",
  "upgrade",
  "approval",
  "approved",
  "wins",
  "growth",
  "raises",
  "strong",
  "profit",
  "gains",
  "outperform",
];

const NEGATIVE_WORDS = [
  "miss",
  "misses",
  "plunge",
  "plunges",
  "slump",
  "lawsuit",
  "probe",
  "downgrade",
  "recall",
  "cuts",
  "layoff",
  "fraud",
  "halt",
  "resign",
  "warns",
  "weak",
  "loss",
  "falls",
  "drop",
  "ban",
  "fine",
];

/** Window (days) over which a headline's recency weight decays to its floor. */
export const RECENCY_DAYS = 21;

/**
 * Detect the market-event type of a headline.
 *
 * @param title - The headline text.
 * @returns The matched rule's type, base weight and default bias.
 */
export function classifyEvent(title: string): {
  type: NewsEventType;
  weight: number;
  bias: -1 | 0 | 1;
} {
  const lower = title.toLowerCase();
  for (const rule of EVENT_RULES) {
    if (rule.keywords.some((k) => lower.includes(k))) {
      return { type: rule.type, weight: rule.weight, bias: rule.bias };
    }
  }
  return { type: "other", weight: FALLBACK_WEIGHT, bias: 0 };
}

/**
 * Score the keyword sentiment of a headline.
 *
 * @param title - The headline text.
 * @returns `1` (net positive), `-1` (net negative) or `0` (neutral/mixed).
 */
export function scoreKeywordSentiment(title: string): -1 | 0 | 1 {
  const lower = title.toLowerCase();
  const pos = POSITIVE_WORDS.filter((w) => lower.includes(w)).length;
  const neg = NEGATIVE_WORDS.filter((w) => lower.includes(w)).length;
  if (pos > neg) return 1;
  if (neg > pos) return -1;
  return 0;
}

/**
 * Compute the recency weight for an article (newer = heavier).
 *
 * @param publishedAtMs - Publication time in ms since epoch.
 * @param nowMs - Current time in ms since epoch.
 * @returns A factor in [0.15, 1].
 */
export function recencyFactor(publishedAtMs: number, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - publishedAtMs) / 86_400_000);
  const factor = 1 - ageDays / RECENCY_DAYS;
  return Math.min(1, Math.max(0.15, factor));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Classify and weight a single article.
 *
 * @param input - The article title and publication timestamp (ISO string).
 * @param nowMs - Current time in ms since epoch.
 * @returns Event type, sentiment, importance weight and signed impact.
 */
export function classifyArticle(
  input: { title: string; publishedAt: string },
  nowMs: number,
): {
  eventType: NewsEventType;
  sentiment: NewsSentiment;
  weight: number;
  impact: number;
} {
  const event = classifyEvent(input.title);
  const keyword = scoreKeywordSentiment(input.title);
  const polarity = keyword !== 0 ? keyword : event.bias;

  const publishedMs = Date.parse(input.publishedAt);
  const recency = Number.isFinite(publishedMs)
    ? recencyFactor(publishedMs, nowMs)
    : 0.5;

  const weight = round2(event.weight * recency);
  const impact = round2(polarity * weight);
  const sentiment: NewsSentiment =
    polarity > 0 ? "positive" : polarity < 0 ? "negative" : "neutral";

  return { eventType: event.type, sentiment, weight, impact };
}

/**
 * Aggregate classified articles into a single news index.
 *
 * @param articles - Articles carrying `weight` and `impact`.
 * @returns The index in [-100, 100] and its sentiment label.
 */
export function computeNewsIndex(
  articles: ReadonlyArray<{ weight: number; impact: number }>,
): { index: number; label: NewsSentiment } {
  const totalWeight = articles.reduce((a, x) => a + x.weight, 0);
  if (totalWeight === 0) return { index: 0, label: "neutral" };
  const totalImpact = articles.reduce((a, x) => a + x.impact, 0);
  const raw = (totalImpact / totalWeight) * 100;
  const index = Math.round(Math.min(100, Math.max(-100, raw)));
  const label: NewsSentiment =
    index > 15 ? "positive" : index < -15 ? "negative" : "neutral";
  return { index, label };
}
