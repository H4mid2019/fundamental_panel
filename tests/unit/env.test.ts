import { describe, expect, it } from "vitest";

import { parseEnv } from "@/lib/env";

describe("parseEnv", () => {
  it("applies defaults for optional values", () => {
    const env = parseEnv({});
    expect(env.OPENROUTER_MODEL).toBe("anthropic/claude-3.5-haiku");
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
  });

  it("accepts valid values", () => {
    const env = parseEnv({
      OPENROUTER_API_KEY: "sk-test",
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
    });
    expect(env.OPENROUTER_API_KEY).toBe("sk-test");
    expect(env.UPSTASH_REDIS_REST_URL).toBe("https://example.upstash.io");
  });

  it("treats blank entries (e.g. copied from .env.example) as unset", () => {
    const env = parseEnv({
      OPENROUTER_API_KEY: "",
      FMP_API_KEY: "   ",
      UPSTASH_REDIS_REST_URL: "",
      UPSTASH_REDIS_REST_TOKEN: "",
      NEXT_PUBLIC_APP_URL: "",
    });
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.FMP_API_KEY).toBeUndefined();
    expect(env.UPSTASH_REDIS_REST_URL).toBeUndefined();
    // Blank values fall through to defaults.
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
  });

  it("throws a descriptive error for malformed URLs", () => {
    expect(() =>
      parseEnv({ UPSTASH_REDIS_REST_URL: "not-a-url" }),
    ).toThrowError(/Invalid environment configuration/);
  });
});
