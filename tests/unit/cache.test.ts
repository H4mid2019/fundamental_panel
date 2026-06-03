import { describe, expect, it } from "vitest";

import { cached, getCached, setCached } from "@/lib/cache";

describe("cache (memory backend)", () => {
  it("returns null on miss and the value after set", async () => {
    expect(await getCached("missing-key")).toBeNull();
    await setCached("k1", { a: 1 }, 60);
    expect(await getCached<{ a: number }>("k1")).toEqual({ a: 1 });
  });

  it("computes and stores on cache miss via cached()", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return { v: calls };
    };
    const first = await cached("k2", 60, compute);
    const second = await cached("k2", 60, compute);
    expect(first).toEqual({ v: 1 });
    expect(second).toEqual({ v: 1 });
    expect(calls).toBe(1);
  });

  it("ignores null/undefined writes", async () => {
    await setCached("k3", null, 60);
    expect(await getCached("k3")).toBeNull();
  });
});
