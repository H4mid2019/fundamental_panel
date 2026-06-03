import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

afterEach(() => vi.restoreAllMocks());

describe("logger", () => {
  it("emits structured JSON for info logs", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logger.info("hello", { foo: "bar" });
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      level: "info",
      message: "hello",
      context: { foo: "bar" },
    });
  });

  it("serializes Error context and routes to console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("failed", { error: new Error("nope") });
    const payload = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(payload.context.error).toMatchObject({
      name: "Error",
      message: "nope",
    });
  });

  it("routes warnings to console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logger.warn("careful");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
