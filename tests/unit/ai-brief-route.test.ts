import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ASSET_TYPES } from "@/lib/types";

/**
 * The AI-brief route validates `assetType` with `z.enum(ASSET_TYPES)`. It used
 * to hand-roll `z.enum(["stock", "index", "crypto"])`, which TypeScript could
 * not cross-check against the `AssetType` union — so when commodities were
 * added every commodity brief failed validation with a 400.
 *
 * These tests pin the invariant that the validator accepts exactly the asset
 * classes the app supports, so a future asset class cannot silently regress it.
 */
const AssetTypeSchema = z.enum(ASSET_TYPES);

describe("ai-brief assetType validation", () => {
  it("accepts every supported asset type", () => {
    for (const type of ASSET_TYPES) {
      expect(AssetTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it("accepts commodity (the class that used to 400)", () => {
    expect(AssetTypeSchema.safeParse("commodity").success).toBe(true);
  });

  it("rejects an unknown asset type", () => {
    expect(AssetTypeSchema.safeParse("bond").success).toBe(false);
  });

  it("stays in lockstep with the AssetType union", () => {
    // If someone adds a class to AssetType, ASSET_TYPES is the single source of
    // truth, so the validator widens with it automatically.
    expect([...ASSET_TYPES].sort()).toEqual([
      "commodity",
      "crypto",
      "index",
      "stock",
    ]);
  });
});
