import { describe, expect, it } from "vitest";

import {
  buildFallbackBrief,
  buildFallbackRecommendation,
  getAIBrief,
  hashInput,
} from "@/lib/ai/openrouter";
import { buildBriefPrompt, type BriefInput } from "@/lib/ai/prompts";

const input: BriefInput = {
  symbol: "AAPL",
  name: "Apple Inc.",
  assetType: "stock",
  indicators: [
    {
      id: "pe",
      label: "P/E Ratio",
      value: 12,
      unit: "x",
      sentiment: "bullish",
    },
    { id: "roe", label: "ROE", value: 4, unit: "%", sentiment: "bearish" },
    { id: "eps", label: "EPS", value: null, unit: "$", sentiment: "unknown" },
  ],
};

describe("buildBriefPrompt", () => {
  it("includes the asset and indicator ids", () => {
    const prompt = buildBriefPrompt(input);
    expect(prompt).toContain("Apple Inc.");
    expect(prompt).toContain("pe");
    expect(prompt).toContain("N/A");
  });

  it("includes the news index and headlines when provided", () => {
    const prompt = buildBriefPrompt({
      ...input,
      newsIndex: 42,
      newsHeadlines: ["CEO steps down", "Earnings beat expectations"],
    });
    expect(prompt).toContain("news index: 42");
    expect(prompt).toContain("CEO steps down");
  });
});

describe("hashInput with news", () => {
  it("changes when the news index changes", () => {
    const base = hashInput(input);
    const withNews = hashInput({
      ...input,
      newsIndex: 30,
      newsHeadlines: ["x"],
    });
    expect(withNews).not.toBe(base);
  });
});

describe("hashInput", () => {
  it("is stable for identical input and changes with values", () => {
    const a = hashInput(input);
    const b = hashInput(input);
    expect(a).toBe(b);
    const changed: BriefInput = {
      ...input,
      indicators: [{ ...input.indicators[0]!, value: 99 }],
    };
    expect(hashInput(changed)).not.toBe(a);
  });
});

describe("buildFallbackBrief", () => {
  it("produces a summary and a note for every indicator", () => {
    const brief = buildFallbackBrief(input);
    expect(brief.fallback).toBe(true);
    expect(brief.summary).toContain("Apple Inc.");
    expect(Object.keys(brief.perIndicator)).toHaveLength(3);
    expect(brief.perIndicator.pe).toBeTruthy();
  });

  it("mentions news tone when a news index is provided", () => {
    const brief = buildFallbackBrief({
      ...input,
      newsIndex: -40,
      newsHeadlines: ["Firm faces lawsuit"],
    });
    expect(brief.summary).toContain("news index -40");
  });
});

describe("buildFallbackRecommendation", () => {
  it("suggests a hedged long when signals are broadly bullish", () => {
    const bullishInput: BriefInput = {
      ...input,
      indicators: [
        { id: "pe", label: "P/E", value: 10, unit: "x", sentiment: "bullish" },
        { id: "roe", label: "ROE", value: 30, unit: "%", sentiment: "bullish" },
        { id: "roa", label: "ROA", value: 15, unit: "%", sentiment: "bullish" },
        { id: "beta", label: "Beta", value: 1, unit: "", sentiment: "neutral" },
      ],
      newsIndex: 40,
      newsHeadlines: ["Earnings beat"],
    };
    const rec = buildFallbackRecommendation(bullishInput);
    expect(rec.stance).toBe("long");
    expect(rec.hedge).toMatch(/put/i);
    expect(rec.scenario?.capitalEur).toBe(10000);
    expect(rec.scenario?.maxGainEur).toBeGreaterThan(0);
    expect(rec.bestHorizonMonths).toBeGreaterThanOrEqual(3);
    expect(rec.bestHorizonMonths).toBeLessThanOrEqual(24);
    expect(rec.rationale).toContain("month");
  });

  it("avoids and omits a scenario when signals are mixed", () => {
    const rec = buildFallbackRecommendation(input);
    expect(rec.stance).toBe("avoid");
    expect(rec.hedge).toBeNull();
    expect(rec.scenario).toBeNull();
  });
});

describe("getAIBrief", () => {
  it("returns the local fallback brief with a recommendation", async () => {
    const result = await getAIBrief({ ...input, symbol: "MSFT" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fallback).toBe(true);
      expect(result.data.model).toBe("local-fallback");
      expect(result.data.recommendation.horizon).toContain("months");
    }
  });
});
