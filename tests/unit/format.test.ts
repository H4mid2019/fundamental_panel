import { describe, expect, it } from "vitest";

import {
  formatChange,
  formatIndicatorValue,
  formatLargeCurrency,
} from "@/lib/format";

describe("formatLargeCurrency", () => {
  it("formats trillions, billions, millions and thousands", () => {
    expect(formatLargeCurrency(1.5e12)).toBe("$1.50T");
    expect(formatLargeCurrency(2.3e9)).toBe("$2.30B");
    expect(formatLargeCurrency(4.5e6)).toBe("$4.50M");
    expect(formatLargeCurrency(7.2e3)).toBe("$7.20K");
    expect(formatLargeCurrency(42)).toBe("$42.00");
  });
  it("handles negatives", () => {
    expect(formatLargeCurrency(-1e12)).toBe("-$1.00T");
  });
});

describe("formatIndicatorValue", () => {
  it("returns N/A for null or non-finite values", () => {
    expect(formatIndicatorValue(null, "ratio")).toBe("N/A");
    expect(formatIndicatorValue(Number.NaN, "percent")).toBe("N/A");
  });
  it("formats each kind", () => {
    expect(formatIndicatorValue(1.234, "ratio")).toBe("1.23x");
    expect(formatIndicatorValue(12.5, "percent")).toBe("12.50%");
    expect(formatIndicatorValue(3.5, "currency")).toBe("$3.50");
    expect(formatIndicatorValue(1e9, "largeCurrency")).toBe("$1.00B");
    expect(formatIndicatorValue(1.2, "number")).toBe("1.20");
  });
});

describe("formatChange", () => {
  it("adds a leading sign and handles null", () => {
    expect(formatChange(2.5)).toBe("+2.50%");
    expect(formatChange(-1.1)).toBe("-1.10%");
    expect(formatChange(null)).toBe("—");
  });
});
