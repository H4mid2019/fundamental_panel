import { describe, expect, it } from "vitest";

import {
  classifyArticle,
  classifyEvent,
  computeNewsIndex,
  recencyFactor,
  scoreKeywordSentiment,
} from "@/lib/news/classify";

describe("classifyEvent", () => {
  const cases: [string, string][] = [
    ["Apple to acquire a startup", "ma"],
    ["Company CEO steps down", "leadership"],
    ["Firm faces lawsuit over data", "legal"],
    ["Regulators grant FDA approval", "regulatory"],
    ["Q3 earnings released", "earnings"],
    ["Company raises guidance", "guidance"],
    ["Firm announces layoffs", "layoffs"],
    ["Analysts issue upgrade and price target", "analyst"],
    ["Firm partners with a vendor", "partnership"],
    ["Board declares dividend", "dividend"],
    ["Company announces share repurchase", "buyback"],
    ["Firm unveils new product", "product"],
    ["A perfectly ordinary headline", "other"],
  ];
  it.each(cases)("classifies %j as %s", (title, type) => {
    expect(classifyEvent(title).type).toBe(type);
  });
});

describe("scoreKeywordSentiment", () => {
  it("detects positive, negative and neutral", () => {
    expect(scoreKeywordSentiment("stock surges to record")).toBe(1);
    expect(scoreKeywordSentiment("shares plunge after miss")).toBe(-1);
    expect(scoreKeywordSentiment("company holds annual meeting")).toBe(0);
  });
});

describe("recencyFactor", () => {
  const now = 100 * 86_400_000;
  it("is 1 for fresh and floors at 0.15 for old", () => {
    expect(recencyFactor(now, now)).toBe(1);
    expect(recencyFactor(now - 100 * 86_400_000, now)).toBe(0.15);
  });
  it("decays linearly within the window", () => {
    const f = recencyFactor(now - 10.5 * 86_400_000, now);
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.6);
  });
});

describe("classifyArticle", () => {
  const now = Date.parse("2024-06-15T00:00:00Z");

  it("scores a recent positive earnings beat as positive", () => {
    const a = classifyArticle(
      {
        title: "Company beats earnings expectations",
        publishedAt: "2024-06-14T00:00:00Z",
      },
      now,
    );
    expect(a.eventType).toBe("earnings");
    expect(a.sentiment).toBe("positive");
    expect(a.impact).toBeGreaterThan(0);
  });

  it("uses event bias when no sentiment keyword is present", () => {
    const a = classifyArticle(
      { title: "Company faces lawsuit", publishedAt: "2024-06-13T00:00:00Z" },
      now,
    );
    expect(a.eventType).toBe("legal");
    expect(a.sentiment).toBe("negative");
    expect(a.impact).toBeLessThan(0);
  });

  it("handles an unparseable date with a neutral recency", () => {
    const a = classifyArticle(
      { title: "An ordinary update", publishedAt: "not-a-date" },
      now,
    );
    expect(a.sentiment).toBe("neutral");
    expect(a.weight).toBeGreaterThan(0);
  });
});

describe("computeNewsIndex", () => {
  it("returns neutral zero for no articles", () => {
    expect(computeNewsIndex([])).toEqual({ index: 0, label: "neutral" });
  });
  it("is positive when impacts are net positive", () => {
    const r = computeNewsIndex([
      { weight: 1, impact: 1 },
      { weight: 0.5, impact: 0.5 },
    ]);
    expect(r.index).toBe(100);
    expect(r.label).toBe("positive");
  });
  it("is negative when impacts are net negative", () => {
    const r = computeNewsIndex([{ weight: 1, impact: -1 }]);
    expect(r.label).toBe("negative");
  });
  it("is neutral when impacts roughly cancel", () => {
    const r = computeNewsIndex([
      { weight: 1, impact: 1 },
      { weight: 1, impact: -1 },
    ]);
    expect(r.index).toBe(0);
    expect(r.label).toBe("neutral");
  });
});
