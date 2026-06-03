import { describe, expect, it } from "vitest";

import { interpretMacro } from "@/lib/macro";

describe("interpretMacro", () => {
  it("reads a low VIX as good and a high VIX as bad", () => {
    expect(interpretMacro("VIXCLS", 12).reading).toBe("good");
    expect(interpretMacro("VIXCLS", 30).reading).toBe("bad");
    expect(interpretMacro("VIXCLS", 20).reading).toBe("neutral");
  });

  it("reads high yields as a headwind", () => {
    expect(interpretMacro("DGS10", 5).reading).toBe("bad");
    expect(interpretMacro("DGS10", 2.5).reading).toBe("good");
  });

  it("returns a description and contextual note", () => {
    const r = interpretMacro("FEDFUNDS", 5.5);
    expect(r.reading).toBe("bad");
    expect(r.description).toMatch(/Federal Funds/i);
    expect(r.note.length).toBeGreaterThan(0);
  });

  it("returns unknown for unconfigured series or null values", () => {
    expect(interpretMacro("XYZ", 1).reading).toBe("unknown");
    expect(interpretMacro("DGS10", null).reading).toBe("unknown");
  });
});
