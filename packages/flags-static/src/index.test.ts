import { describe, expect, it } from "vitest";

import { createStaticFlagProvider } from "./index.js";

describe("createStaticFlagProvider", () => {
  it("returns DEFAULT_FALLBACK for a missing key", async () => {
    const provider = createStaticFlagProvider({ flags: {} });
    const resolution = await provider.resolve({
      flagKey: "missing",
      defaultValue: "fallback",
      kind: "string",
      context: { targetingKey: "user-1" },
    });
    expect(resolution).toEqual({
      value: "fallback",
      reason: "DEFAULT_FALLBACK",
    });
  });

  it("returns DISABLED when the entry is marked disabled", async () => {
    const provider = createStaticFlagProvider({
      flags: { checkoutEnabled: { value: false, disabled: true } },
    });
    const resolution = await provider.resolve({
      flagKey: "checkoutEnabled",
      defaultValue: true,
      kind: "boolean",
      context: { targetingKey: "user-1" },
    });
    expect(resolution).toEqual({
      value: false,
      reason: "DISABLED",
    });
  });

  it("selects flags from the targeting key when asked", async () => {
    const provider = createStaticFlagProvider({
      flagsForContext(context) {
        return context.targetingKey === "user-1" ? { theme: "dark" } : {};
      },
    });
    const matched = await provider.resolve({
      flagKey: "theme",
      defaultValue: "light",
      kind: "string",
      context: { targetingKey: "user-1" },
    });
    const other = await provider.resolve({
      flagKey: "theme",
      defaultValue: "light",
      kind: "string",
      context: { targetingKey: "user-2" },
    });
    expect(matched.reason).toBe("TARGETING_MATCH");
    expect(other.reason).toBe("DEFAULT_FALLBACK");
  });
});
