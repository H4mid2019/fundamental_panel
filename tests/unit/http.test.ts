import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJson } from "@/lib/http";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchJson", () => {
  it("returns ok with parsed data on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ a: 1 })));
    const result = await fetchJson<{ a: number }>("https://x.test/data");
    expect(result).toEqual({ ok: true, data: { a: 1 } });
  });

  it("maps 404 to NOT_FOUND", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    const result = await fetchJson("https://x.test/missing?key=secret");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).not.toContain("secret");
    }
  });

  it("maps other non-2xx to PROVIDER_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 500)));
    const result = await fetchJson("https://x.test/err");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROVIDER_ERROR");
  });

  it("maps aborts to UPSTREAM_TIMEOUT", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    const result = await fetchJson("https://x.test/slow", { timeoutMs: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("maps thrown errors to PROVIDER_ERROR", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const result = await fetchJson("https://x.test/throw");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROVIDER_ERROR");
  });
});
