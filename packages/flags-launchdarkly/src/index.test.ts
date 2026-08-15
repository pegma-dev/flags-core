import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type {
  EvaluationContext,
  FlagResolutionRequest,
} from "@pegma/flags-contracts";

import {
  LAUNCHDARKLY_ERROR_FLAG_NOT_FOUND,
  LAUNCHDARKLY_REASON_ERROR,
  LAUNCHDARKLY_REASON_FALLTHROUGH,
  LAUNCHDARKLY_REASON_OFF,
  LAUNCHDARKLY_REASON_PREREQUISITE_FAILED,
  LAUNCHDARKLY_REASON_RULE_MATCH,
  LAUNCHDARKLY_REASON_TARGET_MATCH,
  createLaunchDarklyFlagProvider,
  launchDarklyUserContext,
  type LaunchDarklyEvaluationDetail,
  type LaunchDarklyReader,
  type LaunchDarklyVariationRequest,
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

function detail(
  value: unknown,
  kind: string,
  extras: {
    readonly errorKind?: string;
    readonly variationIndex?: number;
  } = {},
): LaunchDarklyEvaluationDetail {
  return {
    value,
    reason: {
      kind,
      ...(extras.errorKind === undefined
        ? {}
        : { errorKind: extras.errorKind }),
    },
    ...(extras.variationIndex === undefined
      ? {}
      : { variationIndex: extras.variationIndex }),
  };
}

function memoryReader(
  details: Readonly<Record<string, LaunchDarklyEvaluationDetail>>,
  extras: {
    readonly delayMs?: number;
    readonly error?: unknown;
    readonly onGet?: (request: LaunchDarklyVariationRequest) => void;
    readonly detailsForContext?: (
      context: EvaluationContext,
    ) => Readonly<Record<string, LaunchDarklyEvaluationDetail>>;
  } = {},
): LaunchDarklyReader {
  return {
    async variationDetail(getRequest) {
      extras.onGet?.(getRequest);
      if (extras.delayMs !== undefined && extras.delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, extras.delayMs);
        });
      }
      if (extras.error !== undefined) {
        throw extras.error;
      }
      const table = extras.detailsForContext?.(getRequest.context) ?? details;
      return Object.hasOwn(table, getRequest.flagKey)
        ? table[getRequest.flagKey]
        : undefined;
    },
  };
}

describe("launchDarklyUserContext", () => {
  it("maps targeting key to a single-kind user context", () => {
    expect(
      launchDarklyUserContext({
        targetingKey: "user-1",
        tenant: "acme",
        environment: "prod",
        principalId: "principal-1" as NonNullable<
          EvaluationContext["principalId"]
        >,
        attributes: { plan: "pro", key: "should-not-win" },
      }),
    ).toEqual({
      kind: "user",
      key: "user-1",
      tenant: "acme",
      environment: "prod",
      principalId: "principal-1",
      plan: "pro",
    });
  });
});

describe("createLaunchDarklyFlagProvider", () => {
  it("requires an injected reader", () => {
    expect(() =>
      createLaunchDarklyFlagProvider({} as { reader: LaunchDarklyReader }),
    ).toThrow("injected LaunchDarkly reader");
  });

  it("returns DEFAULT_FALLBACK for a missing key", async () => {
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader({}),
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

  it("returns DEFAULT_FALLBACK for LaunchDarkly FLAG_NOT_FOUND", async () => {
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader({
        theme: detail("light", LAUNCHDARKLY_REASON_ERROR, {
          errorKind: LAUNCHDARKLY_ERROR_FLAG_NOT_FOUND,
        }),
      }),
    });
    await expect(
      provider.resolve(
        request({ flagKey: "theme", kind: "string", defaultValue: "light" }),
      ),
    ).resolves.toEqual({
      value: "light",
      reason: "DEFAULT_FALLBACK",
    });
  });

  it("translates TARGET_MATCH, RULE_MATCH, and FALLTHROUGH as targeting matches", async () => {
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader({
        checkoutEnabled: detail(true, LAUNCHDARKLY_REASON_TARGET_MATCH, {
          variationIndex: 1,
        }),
        theme: detail("dark", LAUNCHDARKLY_REASON_RULE_MATCH, {
          variationIndex: 0,
        }),
        maxItems: detail(25, LAUNCHDARKLY_REASON_FALLTHROUGH),
      }),
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
      reason: "TARGETING_MATCH",
      variant: "1",
    });
    await expect(
      provider.resolve(
        request({ flagKey: "theme", kind: "string", defaultValue: "light" }),
      ),
    ).resolves.toEqual({
      value: "dark",
      reason: "TARGETING_MATCH",
      variant: "0",
    });
    await expect(
      provider.resolve(
        request({ flagKey: "maxItems", kind: "number", defaultValue: 10 }),
      ),
    ).resolves.toEqual({ value: 25, reason: "TARGETING_MATCH" });
  });

  it("translates a json flag without interpreting it", async () => {
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader({
        payload: detail({ experiment: "on" }, LAUNCHDARKLY_REASON_TARGET_MATCH),
      }),
    });
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

  it("translates OFF and PREREQUISITE_FAILED as DISABLED", async () => {
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader({
        checkoutEnabled: detail(false, LAUNCHDARKLY_REASON_OFF, {
          variationIndex: 0,
        }),
        theme: detail("light", LAUNCHDARKLY_REASON_PREREQUISITE_FAILED),
      }),
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
      variant: "0",
    });
    await expect(
      provider.resolve(
        request({ flagKey: "theme", kind: "string", defaultValue: "dark" }),
      ),
    ).resolves.toEqual({
      value: "light",
      reason: "DISABLED",
    });
  });

  it("does not treat an unknown reason as a targeting match", async () => {
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader({
        checkoutEnabled: detail(true, "PERCENTILE_ROLLOUT"),
      }),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).rejects.toThrow("is not translated");
  });

  it("propagates LaunchDarkly evaluation errors other than FLAG_NOT_FOUND", async () => {
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader({
        checkoutEnabled: detail(false, LAUNCHDARKLY_REASON_ERROR, {
          errorKind: "CLIENT_NOT_READY",
        }),
      }),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).rejects.toThrow("CLIENT_NOT_READY");
  });

  it("forwards the targeting key to the reader", async () => {
    const seen: LaunchDarklyVariationRequest[] = [];
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader(
        {
          theme: detail("dark", LAUNCHDARKLY_REASON_TARGET_MATCH),
        },
        {
          onGet(getRequest) {
            seen.push(getRequest);
          },
        },
      ),
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
    expect(seen[0]?.defaultValue).toBe("light");
  });

  it("applies host keyOf without inventing a layout", async () => {
    const seen: LaunchDarklyVariationRequest[] = [];
    const provider = createLaunchDarklyFlagProvider({
      keyOf: (flagKey) => `app.${flagKey}`,
      reader: memoryReader(
        {
          "app.checkoutEnabled": detail(true, LAUNCHDARKLY_REASON_TARGET_MATCH),
        },
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
    expect(seen[0]?.flagKey).toBe("app.checkoutEnabled");
  });

  it("throws when a detail is missing a reason kind", async () => {
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader({
        checkoutEnabled: {
          value: true,
          reason: { kind: "" },
        },
      }),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).rejects.toThrow("reason kind");
  });

  it("propagates reader failures", async () => {
    const provider = createLaunchDarklyFlagProvider({
      reader: memoryReader(
        {},
        { error: new Error("launchdarkly unavailable") },
      ),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).rejects.toThrow("launchdarkly unavailable");
  });

  it("closes the injected reader", async () => {
    const close = vi.fn();
    const provider = createLaunchDarklyFlagProvider({
      reader: { ...memoryReader({}), close },
    });
    await provider.close?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not import a LaunchDarkly SDK or call Date.now on the production path", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).not.toMatch(/@launchdarkly\//u);
    expect(source).not.toMatch(/launchdarkly-node/u);
    expect(source).not.toMatch(/Date\.now\(/u);
  });
});
