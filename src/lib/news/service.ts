import { resolveAssetType } from "../assets";
import { getCached, setCached } from "../cache";
import { features } from "../env";
import { getNewsFixture } from "../fixtures";
import { logger } from "../logger";
import { getNewsArticles } from "../providers/finnhub";
import {
  ok,
  type AppError,
  type NewsAnalysis,
  type NewsArticle,
  type Result,
} from "../types";

import { classifyArticle, computeNewsIndex } from "./classify";

const NEWS_TTL_SECONDS = 15 * 60;
const TOP_TITLES = 20;
const DISPLAY_ARTICLES = 12;

/**
 * Fetch, classify and weight news for an asset into a {@link NewsAnalysis}.
 *
 * Falls back to deterministic fixtures when Finnhub is unconfigured or fails,
 * so the panel always renders. Cached for 15 minutes.
 *
 * @param symbol - The asset symbol.
 * @returns A {@link Result} that resolves to the news analysis.
 */
export async function getNewsAnalysis(
  symbol: string,
): Promise<Result<NewsAnalysis, AppError>> {
  const cacheKey = `news:${symbol.toUpperCase()}`;
  const cachedValue = await getCached<NewsAnalysis>(cacheKey);
  if (cachedValue) return ok(cachedValue);

  const type = resolveAssetType(symbol);
  const now = Date.now();

  const result = await getNewsArticles(symbol, type, now);
  let fallback = !features.finnhub;
  let raw = result.ok ? result.data : [];
  if (!result.ok) {
    logger.warn("news fell back to fixture", { symbol, error: result.error });
    raw = getNewsFixture(symbol, type, now);
    fallback = true;
  }

  const articles: NewsArticle[] = raw
    .map((a) => {
      const c = classifyArticle(a, now);
      return {
        id: a.id,
        title: a.title,
        source: a.source,
        url: a.url,
        publishedAt: a.publishedAt,
        summary: a.summary,
        eventType: c.eventType,
        sentiment: c.sentiment,
        weight: c.weight,
        impact: c.impact,
      };
    })
    .sort(
      (x, y) =>
        y.weight - x.weight ||
        Date.parse(y.publishedAt) - Date.parse(x.publishedAt),
    );

  const { index, label } = computeNewsIndex(articles);

  const analysis: NewsAnalysis = {
    symbol: symbol.toUpperCase(),
    index,
    label,
    articleCount: articles.length,
    topTitles: articles.slice(0, TOP_TITLES).map((a) => a.title),
    articles: articles.slice(0, DISPLAY_ARTICLES),
    asOf: new Date(now).toISOString(),
    fallback,
  };

  await setCached(cacheKey, analysis, NEWS_TTL_SECONDS);
  return ok(analysis);
}
