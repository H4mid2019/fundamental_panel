import { describe, expect, it } from "vitest";

import { clientIp, errorResponse, SymbolSchema } from "@/lib/api";

describe("SymbolSchema", () => {
  it("accepts valid symbols including indexes", () => {
    expect(SymbolSchema.safeParse("AAPL").success).toBe(true);
    expect(SymbolSchema.safeParse("^GSPC").success).toBe(true);
    expect(SymbolSchema.safeParse("BRK.B").success).toBe(true);
  });
  it("rejects empty, oversized or unsafe symbols", () => {
    expect(SymbolSchema.safeParse("").success).toBe(false);
    expect(SymbolSchema.safeParse("A".repeat(13)).success).toBe(false);
    expect(SymbolSchema.safeParse("DROP TABLE").success).toBe(false);
  });
});

describe("clientIp", () => {
  it("reads the first forwarded IP", () => {
    const req = new Request("https://x.test", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    expect(clientIp(req)).toBe("1.2.3.4");
  });
  it("falls back to unknown", () => {
    expect(clientIp(new Request("https://x.test"))).toBe("unknown");
  });
});

describe("errorResponse", () => {
  it("maps error codes to HTTP statuses", () => {
    expect(errorResponse({ code: "NOT_FOUND", message: "x" }).status).toBe(404);
    expect(errorResponse({ code: "RATE_LIMITED", message: "x" }).status).toBe(
      429,
    );
    expect(errorResponse({ code: "UNKNOWN", message: "x" }).status).toBe(500);
  });
});
