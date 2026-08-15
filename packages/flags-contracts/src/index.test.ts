import { describe, expect, it } from "vitest";

import { EVALUATION_REASONS } from "./index.js";

describe("EVALUATION_REASONS", () => {
  it("lists every documented reason", () => {
    expect([...EVALUATION_REASONS]).toEqual([
      "TARGETING_MATCH",
      "DEFAULT_FALLBACK",
      "DISABLED",
      "STALE_CACHE",
      "ERROR",
    ]);
  });
});
