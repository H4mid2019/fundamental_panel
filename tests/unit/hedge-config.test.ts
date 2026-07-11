import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseHedgeConfig } from "@/lib/hedge/config";

/**
 * The real, shipped config — if this stops validating, the app will not boot.
 *
 * Line endings are normalized to LF because the mutation tests below splice
 * strings into it. On a Windows checkout (`core.autocrlf=true`) the file reads
 * back as CRLF, and a `"  - SPY\n"` needle would silently fail to match — the
 * mutation would then be a no-op and the test would "pass" by asserting nothing.
 */
const shipped = readFileSync("hedge.config.yaml", "utf8").replace(
  /\r\n/g,
  "\n",
);

/**
 * Splice a mutation into the shipped config, asserting the needle was actually
 * found. Without this guard a typo'd needle makes the mutation a no-op, the
 * config stays valid, and the "rejects X" test passes while proving nothing.
 */
function mutate(needle: string | RegExp, replacement: string): string {
  const broken = shipped.replace(needle, replacement);
  expect(broken, `mutation did not apply: ${String(needle)}`).not.toBe(shipped);
  return broken;
}

describe("parseHedgeConfig", () => {
  it("validates the config file that ships with the repo", () => {
    const config = parseHedgeConfig(shipped, "hedge.config.yaml");

    expect(config.universe).toContain("SPY");
    expect(config.universe.length).toBeGreaterThan(50);
    expect(config.context.benchmark).toBe("SPY");
    // The VIX term structure needs at least two points to have a slope.
    expect(config.context.vixTerm.length).toBeGreaterThanOrEqual(2);
    expect(config.chain.tenors.skew).toEqual([30, 60, 90, 180]);
    // A sub-30-DTE term tenor must exist, or nothing brackets the 30-day point
    // and VRP's constant-maturity ATM IV becomes uncomputable.
    expect(config.chain.tenors.term.some((t) => t < 30)).toBe(true);
    expect(config.chain.minDte).toBeLessThan(30);
    expect(config.schedule.timezone).toBe("America/New_York");
    expect(config.pairs.list.map((p) => p.id)).toContain("gld-gdx");
  });

  it("rejects malformed YAML with the file name in the message", () => {
    expect(() =>
      parseHedgeConfig("universe: [SPY\n  bad: :", "test.yaml"),
    ).toThrow(/test\.yaml/);
  });

  it("rejects a config missing a required section", () => {
    expect(() => parseHedgeConfig("universe: [SPY]", "test.yaml")).toThrow(
      /Invalid test\.yaml/,
    );
  });

  it("rejects an empty universe — a scan over nothing is a config bug", () => {
    const broken = mutate(
      /^universe:[\s\S]*?^context:/m,
      "universe: []\ncontext:",
    );
    expect(() => parseHedgeConfig(broken, "test.yaml")).toThrow(/universe/);
  });

  it("rejects an inverted range", () => {
    const broken = mutate("otmPctRange: [5, 10]", "otmPctRange: [10, 5]");
    expect(() => parseHedgeConfig(broken, "test.yaml")).toThrow(
      /min must be <= max/,
    );
  });

  it("rejects an IV band whose floor is above its ceiling", () => {
    const broken = mutate("minIv: 0.01", "minIv: 9.0");
    expect(() => parseHedgeConfig(broken, "test.yaml")).toThrow(
      /minIv must be < maxIv/,
    );
  });

  it("rejects an out-of-range threshold rather than silently clamping it", () => {
    const broken = mutate("maxIvRank: 25", "maxIvRank: 250");
    expect(() => parseHedgeConfig(broken, "test.yaml")).toThrow(
      /scanners\.protectivePut\.maxIvRank/,
    );
  });

  it("rejects a concurrency that would hammer Yahoo", () => {
    const broken = mutate("concurrency: 3", "concurrency: 64");
    expect(() => parseHedgeConfig(broken, "test.yaml")).toThrow(
      /chain\.concurrency/,
    );
  });

  it("rejects a non-kebab-case pair id", () => {
    const broken = mutate("id: gld-gdx", "id: GLD_GDX");
    expect(() => parseHedgeConfig(broken, "test.yaml")).toThrow(/kebab-case/);
  });

  it("rejects a ticker with characters no symbol contains", () => {
    const broken = mutate("\n  - SPY\n", "\n  - 'SP Y!'\n");
    expect(() => parseHedgeConfig(broken, "test.yaml")).toThrow(
      /Invalid ticker symbol/,
    );
  });
});
