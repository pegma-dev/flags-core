import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type {
  EvaluationContext,
  FlagResolutionRequest,
} from "@pegma/flags-contracts";

import {
  FLAGSHIP_ERROR_FLAG_NOT_FOUND,
  FLAGSHIP_REASON_CACHED,
  FLAGSHIP_REASON_DEFAULT,
  FLAGSHIP_REASON_DISABLED,
  FLAGSHIP_REASON_ERROR,
  FLAGSHIP_REASON_SPLIT,
  FLAGSHIP_REASON_TARGETING_MATCH,
  createCloudflareFlagshipFlagProvider,
  flagshipEvaluationContext,
  type FlagshipDetailsRequest,
  type FlagshipEvaluationDetails,
  type FlagshipReader,
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
  reason: string,
  extras: {
    readonly errorCode?: string;
    readonly variant?: string;
  } = {},
): FlagshipEvaluationDetails {
  return {
    value,
    reason,
    ...(extras.errorCode === undefined ? {} : { errorCode: extras.errorCode }),
    ...(extras.variant === undefined ? {} : { variant: extras.variant }),
  };
}

function memoryReader(
  details: Readonly<Record<string, FlagshipEvaluationDetails>>,
  extras: {
    readonly delayMs?: number;
    readonly error?: unknown;
    readonly onGet?: (request: FlagshipDetailsRequest) => void;
    readonly detailsForContext?: (
      context: EvaluationContext,
    ) => Readonly<Record<string, FlagshipEvaluationDetails>>;
  } = {},
): FlagshipReader {
  return {
    async getDetails(getRequest) {
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

describe("flagshipEvaluationContext", () => {
  it("maps targeting key and scalar attributes", () => {
    expect(
      flagshipEvaluationContext({
        targetingKey: "user-1",
        tenant: "acme",
        environment: "prod",
        principalId: "principal-1" as NonNullable<
          EvaluationContext["principalId"]
        >,
        attributes: {
          plan: "pro",
          seats: 3,
          beta: true,
          targetingKey: "should-not-win",
          nested: { ignored: true },
        },
      }),
    ).toEqual({
      targetingKey: "user-1",
      tenant: "acme",
      environment: "prod",
      principalId: "principal-1",
      plan: "pro",
      seats: 3,
      beta: true,
    });
  });
});

describe("createCloudflareFlagshipFlagProvider", () => {
  it("requires an injected reader", () => {
    expect(() =>
      createCloudflareFlagshipFlagProvider({} as { reader: FlagshipReader }),
    ).toThrow("injected Flagship reader");
  });

  it("returns DEFAULT_FALLBACK for a missing key", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
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

  it("returns DEFAULT_FALLBACK for Flagship FLAG_NOT_FOUND", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader({
        theme: detail("light", FLAGSHIP_REASON_ERROR, {
          errorCode: FLAGSHIP_ERROR_FLAG_NOT_FOUND,
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

  it("translates TARGETING_MATCH, SPLIT, DEFAULT, and CACHED as targeting matches", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader({
        checkoutEnabled: detail(true, FLAGSHIP_REASON_TARGETING_MATCH, {
          variant: "on",
        }),
        theme: detail("dark", FLAGSHIP_REASON_SPLIT, {
          variant: "dark",
        }),
        maxItems: detail(25, FLAGSHIP_REASON_DEFAULT),
        payload: detail({ experiment: "on" }, FLAGSHIP_REASON_CACHED),
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
      variant: "on",
    });
    await expect(
      provider.resolve(
        request({ flagKey: "theme", kind: "string", defaultValue: "light" }),
      ),
    ).resolves.toEqual({
      value: "dark",
      reason: "TARGETING_MATCH",
      variant: "dark",
    });
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

  it("omits variant when Flagship returns an empty variant", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader({
        theme: detail("dark", FLAGSHIP_REASON_TARGETING_MATCH, {
          variant: "",
        }),
      }),
    });
    await expect(
      provider.resolve(
        request({ flagKey: "theme", kind: "string", defaultValue: "light" }),
      ),
    ).resolves.toEqual({
      value: "dark",
      reason: "TARGETING_MATCH",
    });
  });

  it("translates DISABLED as DISABLED", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader({
        checkoutEnabled: detail(false, FLAGSHIP_REASON_DISABLED, {
          variant: "off",
        }),
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
      variant: "off",
    });
  });

  it("does not treat an unknown reason as a targeting match", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
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

  it("propagates Flagship evaluation errors without an errorCode", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader({
        checkoutEnabled: detail(false, FLAGSHIP_REASON_ERROR),
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
    ).rejects.toThrow("Flagship evaluation failed for checkoutEnabled");
  });

  it("propagates Flagship evaluation errors other than FLAG_NOT_FOUND", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader({
        checkoutEnabled: detail(false, FLAGSHIP_REASON_ERROR, {
          errorCode: "TYPE_MISMATCH",
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
    ).rejects.toThrow("TYPE_MISMATCH");
  });

  it("does not treat an errorCode on a match as a targeting match", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader({
        checkoutEnabled: detail(true, FLAGSHIP_REASON_TARGETING_MATCH, {
          errorCode: "GENERAL",
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
    ).rejects.toThrow("GENERAL");
  });

  it("forwards the targeting key and kind to the reader", async () => {
    const seen: FlagshipDetailsRequest[] = [];
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader(
        {
          theme: detail("dark", FLAGSHIP_REASON_TARGETING_MATCH),
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
    expect(seen[0]?.kind).toBe("string");
  });

  it("applies host keyOf without inventing a layout", async () => {
    const seen: FlagshipDetailsRequest[] = [];
    const provider = createCloudflareFlagshipFlagProvider({
      keyOf: (flagKey) => `app.${flagKey}`,
      reader: memoryReader(
        {
          "app.checkoutEnabled": detail(true, FLAGSHIP_REASON_TARGETING_MATCH),
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

  it("throws when a detail is missing a reason", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader({
        checkoutEnabled: {
          value: true,
          reason: "",
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
    ).rejects.toThrow("reason");
  });

  it("propagates reader failures", async () => {
    const provider = createCloudflareFlagshipFlagProvider({
      reader: memoryReader({}, { error: new Error("flagship unavailable") }),
    });
    await expect(
      provider.resolve(
        request({
          flagKey: "checkoutEnabled",
          kind: "boolean",
          defaultValue: false,
        }),
      ),
    ).rejects.toThrow("flagship unavailable");
  });

  it("closes the injected reader", async () => {
    const close = vi.fn();
    const provider = createCloudflareFlagshipFlagProvider({
      reader: { ...memoryReader({}), close },
    });
    await provider.close?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not import a Flagship SDK or call Date.now on the production path", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).not.toMatch(/@cloudflare\/flagship/u);
    expect(source).not.toMatch(/@cloudflare\/workers-types/u);
    expect(source).not.toMatch(/Date\.now\(/u);
  });
});
