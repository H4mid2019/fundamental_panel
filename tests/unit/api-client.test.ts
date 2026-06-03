import { afterEach, describe, expect, it, vi } from "vitest";

import { apiGet, apiPost, ApiError } from "@/lib/api-client";

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

describe("apiGet", () => {
  it("returns parsed JSON on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ a: 1 })));
    await expect(apiGet<{ a: number }>("/api/x")).resolves.toEqual({ a: 1 });
  });

  it("throws an ApiError carrying the API error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: "NOT_FOUND", message: "nope" } }, 404),
        ),
    );
    await expect(apiGet("/api/missing")).rejects.toMatchObject({
      name: "ApiError",
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("defaults to UNKNOWN for non-JSON error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("oops", { status: 500 })),
    );
    const error = await apiGet("/api/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("UNKNOWN");
  });
});

describe("apiPost", () => {
  it("posts a JSON body and returns the parsed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiPost("/api/x", { q: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/x",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
