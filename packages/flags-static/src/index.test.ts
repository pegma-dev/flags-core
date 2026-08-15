import { describe, expect, it } from "vitest";

import { createStaticFlagProvider, staticFlag } from "./index.js";

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

  it("returns DISABLED only for an explicit staticFlag wrapper", async () => {
    const provider = createStaticFlagProvider({
      flags: { checkoutEnabled: staticFlag({ value: false, disabled: true }) },
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

  it("treats a JSON object with value/disabled keys as the payload", async () => {
    const payload = { value: 1, disabled: true, variant: "control" };
    const provider = createStaticFlagProvider({
      flags: { payload },
    });
    const resolution = await provider.resolve({
      flagKey: "payload",
      defaultValue: {},
      kind: "json",
      context: { targetingKey: "user-1" },
    });
    expect(resolution).toEqual({
      value: payload,
      reason: "TARGETING_MATCH",
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
