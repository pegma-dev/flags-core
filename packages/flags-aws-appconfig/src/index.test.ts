import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type {
  EvaluationContext,
  FlagResolutionRequest,
} from "@pegma/flags-contracts";

import {
  AWS_APPCONFIG_FEATURE_FLAGS_TYPE,
  awsAppConfigFlagValue,
  createAwsAppConfigFlagProvider,
  type AwsAppConfigConfiguration,
  type AwsAppConfigGetRequest,
  type AwsAppConfigReader,
} from "./index.js";

const context: EvaluationContext = { targetingKey: "user-1" };

function request(
  extras: Partial<FlagResolutionRequest> &
    Pick<FlagResolutionRequest, "flagKey" | "kind" | "defaultValue">,
): FlagResolutionRequest {
  return {
    context,
    ...extras,
  };
}

function configuration(
  key: string,
  value: unknown,
  extras: Omit<AwsAppConfigConfiguration, "key" | "value"> = {},
): AwsAppConfigConfiguration {
  return {
    key,
    value,
    ...extras,
  };
}

function featureFlag(key: string, value: unknown): AwsAppConfigConfiguration {
  return configuration(key, value, { type: AWS_APPCONFIG_FEATURE_FLAGS_TYPE });
}

function memoryReader(
  configurations: readonly AwsAppConfigConfiguration[],
  extras: {
    readonly delayMs?: number;
    readonly error?: unknown;
    readonly onGet?: (request: AwsAppConfigGetRequest) => void;
  } = {},
): AwsAppConfigReader {
  return {
    async getConfiguration(getRequest) {
      extras.onGet?.(getRequest);
      if (extras.delayMs !== undefined && extras.delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, extras.delayMs);
        });
      }
      if (extras.error !== undefined) {
        throw extras.error;
      }
      return configurations.find((entry) => entry.key === getRequest.key);
    },
  };
}

describe("awsAppConfigFlagValue", () => {
  it("reads a flag from an AWS.AppConfig.FeatureFlags document", () => {
    expect(AWS_APPCONFIG_FEATURE_FLAGS_TYPE).toBe("AWS.AppConfig.FeatureFlags");
    expect(
      awsAppConfigFlagValue(
        {
          version: "1",
          flags: { checkoutEnabled: { name: "checkoutEnabled" } },
          values: { checkoutEnabled: { enabled: true } },
        },
        "checkoutEnabled",
      ),
    ).toEqual({ enabled: true });
  });

  it("reads a flag from a retrieved flag map", () => {
    expect(
      awsAppConfigFlagValue(
        { checkoutEnabled: { enabled: false } },
        "checkoutEnabled",
      ),
    ).toEqual({ enabled: false });
  });

  it("returns undefined for a missing key", () => {
    expect(awsAppConfigFlagValue({ version: "1", values: {} }, "theme")).toBe(
      undefined,
    );
    expect(
      awsAppConfigFlagValue({ checkoutEnabled: { enabled: true } }, "theme"),
    ).toBe(undefined);
  });
});

describe("createAwsAppConfigFlagProvider", () => {
  it("requires an injected reader", () => {
    expect(() =>
      createAwsAppConfigFlagProvider({} as { reader: AwsAppConfigReader }),
    ).toThrow("injected AWS AppConfig reader");
  });

  it("returns DEFAULT_FALLBACK for a missing key", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "theme",
          kind: "string",
          defaultValue: "light",
        }),
      ),
    ).resolves.toEqual({
      value: "light",
      reason: "DEFAULT_FALLBACK",
    });
  });

  it("looks up the flag key as an already-evaluated value by default", async () => {
    const seen: AwsAppConfigGetRequest[] = [];
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([configuration("theme", "dark")], {
        onGet(getRequest) {
          seen.push(getRequest);
        },
      }),
    });
    const resolution = await provider.resolve(
      request({ flagKey: "theme", kind: "string", defaultValue: "light" }),
    );
    expect(resolution).toEqual({ value: "dark", reason: "TARGETING_MATCH" });
    expect(seen[0]?.key).toBe("theme");
  });

  it("parses boolean, number, and json ordinary values", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        configuration("checkoutEnabled", "true"),
        configuration("maxItems", "25"),
        configuration("payload", '{"experiment":"on"}'),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).resolves.toEqual({ value: true, reason: "TARGETING_MATCH" });
    await expect(
      provider.resolve(
        request({ flagKey: "maxItems", kind: "number", defaultValue: 10 }),
      ),
    ).resolves.toEqual({ value: 25, reason: "TARGETING_MATCH" });
    await expect(
      provider.resolve(
        request({
          flagKey: "payload",
          kind: "json",
          defaultValue: { experiment: "off" },
        }),
      ),
    ).resolves.toEqual({
      value: { experiment: "on" },
      reason: "TARGETING_MATCH",
    });
  });

  it("does not JSON-parse ordinary string values", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([configuration("theme", "dark")]),
    });
    await expect(
      provider.resolve(
        request({ flagKey: "theme", kind: "string", defaultValue: "light" }),
      ),
    ).resolves.toEqual({ value: "dark", reason: "TARGETING_MATCH" });
  });

  it("translates an already-evaluated boolean without a document", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([configuration("checkoutEnabled", true)]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).resolves.toEqual({ value: true, reason: "TARGETING_MATCH" });
  });

  it("translates an enabled feature flag with no targeting rules", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([featureFlag("checkoutEnabled", { enabled: true })]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).resolves.toEqual({ value: true, reason: "TARGETING_MATCH" });
  });

  it("does not treat a multi-variant rule as an unconditional match", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", {
          enabled: true,
          _variants: [
            {
              name: "beta",
              enabled: true,
              rule: 'splits(["$userId"], {"seed":"checkout"}) < 25',
            },
            { name: "default", enabled: false },
          ],
        }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).rejects.toThrow("does not evaluate");
  });

  it("does not treat a percentage split as a stored default match", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", {
          _variants: [
            {
              name: "on",
              enabled: true,
              rule: "percent(50)",
            },
            { name: "default", enabled: false },
          ],
        }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).rejects.toThrow("does not evaluate");
  });

  it("keeps a disabled feature flag DISABLED even when leftover rules exist", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", {
          enabled: false,
          _variants: [
            {
              name: "beta",
              enabled: true,
              rule: "percent(100)",
            },
            { name: "default", enabled: false },
          ],
        }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: true,
        }),
      ),
    ).resolves.toEqual({
      value: false,
      reason: "DISABLED",
      variant: "default",
    });
  });

  it("translates a disabled feature flag as DISABLED", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", { enabled: false }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: true,
        }),
      ),
    ).resolves.toEqual({ value: false, reason: "DISABLED" });
  });

  it("reads a default variant without a rule as stored data, not a rollout", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", {
          enabled: false,
          _variants: [{ name: "stored", enabled: true }],
        }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).resolves.toEqual({
      value: true,
      reason: "DISABLED",
      variant: "stored",
    });
  });

  it("does not unwrap an attribute that shares the flag key", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", {
          enabled: true,
          checkoutEnabled: "dark",
        }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).resolves.toEqual({ value: true, reason: "TARGETING_MATCH" });
  });

  it("extracts a flag from a retrieved flag map", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", {
          checkoutEnabled: { enabled: true },
          theme: { enabled: false },
        }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).resolves.toEqual({ value: true, reason: "TARGETING_MATCH" });
  });

  it("extracts a flag from an AWS.AppConfig.FeatureFlags document", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        configuration(
          "checkoutEnabled",
          {
            version: "1",
            flags: { checkoutEnabled: { name: "checkoutEnabled" } },
            values: { checkoutEnabled: { enabled: true } },
          },
          { type: AWS_APPCONFIG_FEATURE_FLAGS_TYPE },
        ),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).resolves.toEqual({ value: true, reason: "TARGETING_MATCH" });
  });

  it("forwards the targeting key to the reader", async () => {
    const seen: AwsAppConfigGetRequest[] = [];
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([configuration("theme", "dark")], {
        onGet(getRequest) {
          seen.push(getRequest);
        },
      }),
    });
    await provider.resolve(
      request({
        flagKey: "theme",
        kind: "string",
        defaultValue: "light",
        context: { targetingKey: "user-1" },
      }),
    );
    expect(seen[0]?.context.targetingKey).toBe("user-1");
  });

  it("applies host keyOf without inventing a layout", async () => {
    const seen: AwsAppConfigGetRequest[] = [];
    const provider = createAwsAppConfigFlagProvider({
      keyOf: (flagKey) => `app/${flagKey}`,
      reader: memoryReader(
        [featureFlag("app/checkoutEnabled", { enabled: true })],
        {
          onGet(getRequest) {
            seen.push(getRequest);
          },
        },
      ),
    });
    const resolution = await provider.resolve(
      request({
        flagKey: "checkoutEnabled",
        kind: "boolean",
        defaultValue: false,
      }),
    );
    expect(resolution.reason).toBe("TARGETING_MATCH");
    expect(seen[0]?.key).toBe("app/checkoutEnabled");
  });

  it("throws when a typed ordinary value is not JSON", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([configuration("maxItems", "twenty-five")]),
    });
    await expect(
      provider.resolve(
        request({ flagKey: "maxItems", kind: "number", defaultValue: 10 }),
      ),
    ).rejects.toThrow("not valid JSON");
  });

  it("returns an ordinary JSON object that contains enabled", async () => {
    const payload = { enabled: true, mode: "dark" };
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([configuration("payload", payload)]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "payload",
          kind: "json",
          defaultValue: { enabled: false, mode: "light" },
        }),
      ),
    ).resolves.toEqual({
      value: payload,
      reason: "TARGETING_MATCH",
    });
  });

  it("returns DEFAULT_FALLBACK for a missing key in a feature-flag document", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("theme", {
          version: "1",
          flags: { checkoutEnabled: { name: "checkoutEnabled" } },
          values: { checkoutEnabled: { enabled: true } },
        }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "theme",
          kind: "string",
          defaultValue: "light",
        }),
      ),
    ).resolves.toEqual({
      value: "light",
      reason: "DEFAULT_FALLBACK",
    });
  });

  it("returns DEFAULT_FALLBACK for a missing key in a feature-flag map", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("theme", {
          checkoutEnabled: { enabled: true },
        }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "theme",
          kind: "string",
          defaultValue: "light",
        }),
      ),
    ).resolves.toEqual({
      value: "light",
      reason: "DEFAULT_FALLBACK",
    });
  });

  it("throws when a feature flag document is malformed", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", { enabled: "yes" }),
      ]),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).rejects.toThrow("boolean enabled field");
  });

  it("propagates reader failures", async () => {
    const provider = createAwsAppConfigFlagProvider({
      reader: memoryReader([], { error: new Error("appconfig unavailable") }),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).rejects.toThrow("appconfig unavailable");
  });

  it("closes the injected reader", async () => {
    const close = vi.fn();
    const provider = createAwsAppConfigFlagProvider({
      reader: { ...memoryReader([]), close },
    });
    await provider.close?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not import an AWS SDK or call Date.now on the production path", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).not.toMatch(/@aws-sdk\//u);
    expect(source).not.toMatch(/aws-sdk/u);
    expect(source).not.toMatch(/Date\.now\(/u);
  });
});
