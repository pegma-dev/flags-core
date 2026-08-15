import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type {
  EvaluationContext,
  FlagResolutionRequest,
} from "@pegma/flags-contracts";

import {
  AZURE_FEATURE_FLAG_CONTENT_TYPE,
  AZURE_FEATURE_FLAG_KEY_PREFIX,
  azureFeatureFlagKey,
  createAzureAppConfigFlagProvider,
  type AzureAppConfigurationGetRequest,
  type AzureAppConfigurationReader,
  type AzureAppConfigurationSetting,
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

function kv(
  key: string,
  value: string,
  extras: Omit<AzureAppConfigurationSetting, "key" | "value"> = {},
): AzureAppConfigurationSetting {
  return {
    key,
    value,
    ...extras,
  };
}

function featureFlag(
  key: string,
  document: object,
): AzureAppConfigurationSetting {
  return {
    key,
    value: JSON.stringify(document),
    contentType: AZURE_FEATURE_FLAG_CONTENT_TYPE,
  };
}

function memoryReader(
  settings: readonly AzureAppConfigurationSetting[],
  extras: {
    readonly delayMs?: number;
    readonly error?: unknown;
    readonly onGet?: (request: AzureAppConfigurationGetRequest) => void;
  } = {},
): AzureAppConfigurationReader {
  return {
    async getConfigurationSetting(getRequest) {
      extras.onGet?.(getRequest);
      if (extras.delayMs !== undefined && extras.delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, extras.delayMs);
        });
      }
      if (extras.error !== undefined) {
        throw extras.error;
      }
      return settings.find((setting) => {
        return (
          setting.key === getRequest.key && setting.label === getRequest.label
        );
      });
    },
  };
}

describe("azureFeatureFlagKey", () => {
  it("uses Microsoft's documented feature-flag prefix", () => {
    expect(AZURE_FEATURE_FLAG_KEY_PREFIX).toBe(".appconfig.featureflag/");
    expect(azureFeatureFlagKey("checkoutEnabled")).toBe(
      ".appconfig.featureflag/checkoutEnabled",
    );
  });
});

describe("createAzureAppConfigFlagProvider", () => {
  it("requires an injected reader", () => {
    expect(() =>
      createAzureAppConfigFlagProvider(
        {} as { reader: AzureAppConfigurationReader },
      ),
    ).toThrow("injected Azure App Configuration reader");
  });

  it("returns DEFAULT_FALLBACK for a missing key", async () => {
    const provider = createAzureAppConfigFlagProvider({
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

  it("looks up the flag key as an ordinary setting by default", async () => {
    const seen: AzureAppConfigurationGetRequest[] = [];
    const provider = createAzureAppConfigFlagProvider({
      reader: memoryReader([kv("theme", "dark")], {
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

  it("parses boolean, number, and json ordinary settings", async () => {
    const provider = createAzureAppConfigFlagProvider({
      reader: memoryReader([
        kv("checkoutEnabled", "true"),
        kv("maxItems", "25"),
        kv("payload", '{"experiment":"on"}'),
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

  it("does not JSON-parse ordinary string settings", async () => {
    const provider = createAzureAppConfigFlagProvider({
      reader: memoryReader([kv("theme", "dark")]),
    });
    await expect(
      provider.resolve(
        request({ flagKey: "theme", kind: "string", defaultValue: "light" }),
      ),
    ).resolves.toEqual({ value: "dark", reason: "TARGETING_MATCH" });
  });

  it("translates an enabled feature flag without evaluating filters", async () => {
    const provider = createAzureAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", {
          id: "checkoutEnabled",
          enabled: true,
          conditions: {
            client_filters: [
              {
                name: "Microsoft.Percentage",
                parameters: { Value: 0 },
              },
            ],
          },
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

  it("translates a disabled feature flag as DISABLED", async () => {
    const provider = createAzureAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", {
          id: "checkoutEnabled",
          enabled: false,
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
    ).resolves.toEqual({ value: false, reason: "DISABLED" });
  });

  it("reads default_when_disabled as stored data, not a rollout", async () => {
    const provider = createAzureAppConfigFlagProvider({
      reader: memoryReader([
        featureFlag("checkoutEnabled", {
          id: "checkoutEnabled",
          enabled: false,
          variants: [{ name: "stored", configuration_value: true }],
          allocation: { default_when_disabled: "stored" },
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

  it("forwards the targeting key to the reader", async () => {
    const seen: AzureAppConfigurationGetRequest[] = [];
    const provider = createAzureAppConfigFlagProvider({
      reader: memoryReader([kv("theme", "dark")], {
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

  it("applies host keyOf and labelOf without inventing a layout", async () => {
    const seen: AzureAppConfigurationGetRequest[] = [];
    const provider = createAzureAppConfigFlagProvider({
      keyOf: azureFeatureFlagKey,
      labelOf: (evaluationContext) => evaluationContext.environment,
      reader: memoryReader(
        [
          {
            key: azureFeatureFlagKey("checkoutEnabled"),
            label: "prod",
            value: JSON.stringify({
              id: "checkoutEnabled",
              enabled: true,
            }),
            contentType: AZURE_FEATURE_FLAG_CONTENT_TYPE,
          },
        ],
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
        context: { targetingKey: "user-1", environment: "prod" },
      }),
    );
    expect(resolution.reason).toBe("TARGETING_MATCH");
    expect(seen[0]?.key).toBe(".appconfig.featureflag/checkoutEnabled");
    expect(seen[0]?.label).toBe("prod");
  });

  it("throws when a typed ordinary setting is not JSON", async () => {
    const provider = createAzureAppConfigFlagProvider({
      reader: memoryReader([kv("maxItems", "twenty-five")]),
    });
    await expect(
      provider.resolve(
        request({ flagKey: "maxItems", kind: "number", defaultValue: 10 }),
      ),
    ).rejects.toThrow("not valid JSON");
  });

  it("throws when a feature flag document is malformed", async () => {
    const provider = createAzureAppConfigFlagProvider({
      reader: memoryReader([
        kv("checkoutEnabled", "{}", {
          contentType: AZURE_FEATURE_FLAG_CONTENT_TYPE,
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
    ).rejects.toThrow("boolean enabled field");
  });

  it("propagates reader failures", async () => {
    const provider = createAzureAppConfigFlagProvider({
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
    const provider = createAzureAppConfigFlagProvider({
      reader: { ...memoryReader([]), close },
    });
    await provider.close?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not import an Azure SDK or call Date.now on the production path", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).not.toMatch(/@azure\//u);
    expect(source).not.toMatch(/Date\.now\(/u);
  });
});
