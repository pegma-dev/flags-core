import { fixedClock, type Logger } from "@pegma/spine";
import { describe, expect, it } from "vitest";

import {
  cacheIdentity,
  createFlagsClient,
  loggableError,
  type FlagsClientOptions,
} from "./client.js";
import { declareFlags, flag } from "./schema.js";
import type {
  EvaluationContext,
  FlagProvider,
  FlagResolution,
} from "@pegma/flags-contracts";

const schema = declareFlags({
  checkoutEnabled: flag.boolean({ defaultValue: false }),
  theme: flag.string({ defaultValue: "light" }),
});

function memoryLogger(): {
  logger: Logger;
  events: Array<{
    level: string;
    message: string;
    fields?: Readonly<Record<string, unknown>>;
  }>;
} {
  const events: Array<{
    level: string;
    message: string;
    fields?: Readonly<Record<string, unknown>>;
  }> = [];
  return {
    events,
    logger: {
      log(level, message, fields) {
        events.push({
          level,
          message,
          ...(fields === undefined ? {} : { fields }),
        });
      },
    },
  };
}

function staticProvider(
  flags: Readonly<Record<string, unknown>>,
  extras: {
    readonly delayMs?: number;
    readonly reason?: FlagResolution["reason"];
    readonly errorMessage?: string;
  } = {},
): FlagProvider {
  return {
    name: "test",
    capabilities() {
      return { static: true, streaming: false, targeting: false };
    },
    async resolve(request) {
      if (extras.delayMs !== undefined) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, extras.delayMs);
        });
      }
      if (Object.hasOwn(flags, request.flagKey)) {
        return {
          value: flags[request.flagKey],
          reason: extras.reason ?? "TARGETING_MATCH",
          ...(extras.errorMessage === undefined
            ? {}
            : { errorMessage: extras.errorMessage }),
        };
      }
      return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
    },
  };
}

describe("createFlagsClient", () => {
  it("requires an injected logger", () => {
    expect(() =>
      createFlagsClient({
        schema,
        provider: staticProvider({}),
      } as FlagsClientOptions<typeof schema>),
    ).toThrow("injected Logger");
  });

  it("rejects an empty targeting key", async () => {
    const { logger } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      provider: staticProvider({}),
    });
    await expect(
      client.evaluate("checkoutEnabled", { targetingKey: "" }),
    ).rejects.toThrow("targetingKey");
  });

  it("returns a fresh cache hit with the original reason", async () => {
    let resolves = 0;
    const { logger } = memoryLogger();
    const provider: FlagProvider = {
      name: "counting",
      capabilities() {
        return { static: true, streaming: false, targeting: false };
      },
      async resolve() {
        resolves += 1;
        return { value: true, reason: "TARGETING_MATCH" };
      },
    };
    const client = createFlagsClient({
      schema,
      logger,
      provider,
      cacheTtlMs: 60_000,
      clock: fixedClock("2026-08-15T12:00:00.000Z"),
    });
    await client.evaluate("checkoutEnabled", { targetingKey: "user-1" });
    const second = await client.evaluate("checkoutEnabled", {
      targetingKey: "user-1",
    });
    expect(resolves).toBe(1);
    expect(second.reason).toBe("TARGETING_MATCH");
    expect(second.value).toBe(true);
  });

  it("serves STALE_CACHE without waiting on refresh", async () => {
    let current = "2026-08-15T12:00:00.000Z";
    const clock = { now: () => current };
    let resolves = 0;
    const { logger } = memoryLogger();
    const provider: FlagProvider = {
      name: "slow-refresh",
      capabilities() {
        return { static: true, streaming: false, targeting: false };
      },
      async resolve() {
        resolves += 1;
        if (resolves === 1) {
          return { value: true, reason: "TARGETING_MATCH" };
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
        return { value: false, reason: "TARGETING_MATCH" };
      },
    };
    const client = createFlagsClient({
      schema,
      logger,
      provider,
      clock,
      cacheTtlMs: 1_000,
      staleWhileRevalidateMs: 60_000,
    });
    await client.evaluate("checkoutEnabled", { targetingKey: "user-1" });
    current = "2026-08-15T12:00:02.000Z";
    const stale = await client.evaluate("checkoutEnabled", {
      targetingKey: "user-1",
    });
    expect(stale.reason).toBe("STALE_CACHE");
    expect(stale.value).toBe(true);
    expect(resolves).toBe(2);
  });

  it("does not serve an expired cache entry after provider failure", async () => {
    let current = "2026-08-15T12:00:00.000Z";
    const clock = { now: () => current };
    let resolves = 0;
    const { logger, events } = memoryLogger();
    const provider: FlagProvider = {
      name: "then-fail",
      capabilities() {
        return { static: true, streaming: false, targeting: false };
      },
      async resolve() {
        resolves += 1;
        if (resolves === 1) {
          return { value: true, reason: "TARGETING_MATCH" };
        }
        throw new Error("provider unavailable");
      },
    };
    const client = createFlagsClient({
      schema,
      logger,
      provider,
      clock,
      cacheTtlMs: 1_000,
      staleWhileRevalidateMs: 1_000,
    });
    const first = await client.evaluate("checkoutEnabled", {
      targetingKey: "user-1",
    });
    expect(first).toMatchObject({ value: true, reason: "TARGETING_MATCH" });
    current = "2026-08-15T12:00:03.000Z";
    const expired = await client.evaluate("checkoutEnabled", {
      targetingKey: "user-1",
    });
    expect(expired).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "PROVIDER",
    });
    expect(resolves).toBe(2);
    expect(events.some((event) => event.message === "flags.fallback")).toBe(
      true,
    );
  });

  it("still serves STALE_CACHE while the stale window is open", async () => {
    let current = "2026-08-15T12:00:00.000Z";
    const clock = { now: () => current };
    let resolves = 0;
    const { logger } = memoryLogger();
    const provider: FlagProvider = {
      name: "then-fail-in-window",
      capabilities() {
        return { static: true, streaming: false, targeting: false };
      },
      async resolve() {
        resolves += 1;
        if (resolves === 1) {
          return { value: true, reason: "TARGETING_MATCH" };
        }
        throw new Error("provider unavailable");
      },
    };
    const client = createFlagsClient({
      schema,
      logger,
      provider,
      clock,
      cacheTtlMs: 1_000,
      staleWhileRevalidateMs: 30_000,
    });
    await client.evaluate("checkoutEnabled", { targetingKey: "user-1" });
    current = "2026-08-15T12:00:02.000Z";
    const stale = await client.evaluate("checkoutEnabled", {
      targetingKey: "user-1",
    });
    expect(stale).toMatchObject({ value: true, reason: "STALE_CACHE" });
  });

  it("logs cached fallback reasons on later hits", async () => {
    const { logger, events } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      cacheTtlMs: 60_000,
      clock: fixedClock("2026-08-15T12:00:00.000Z"),
      provider: staticProvider({}),
    });
    const first = await client.evaluate("theme", { targetingKey: "user-1" });
    const second = await client.evaluate("theme", { targetingKey: "user-1" });
    expect(first.reason).toBe("DEFAULT_FALLBACK");
    expect(second.reason).toBe("DEFAULT_FALLBACK");
    expect(
      events.filter((event) => event.message === "flags.fallback"),
    ).toHaveLength(2);
  });

  it("logs cached DISABLED and ERROR hits", async () => {
    const { logger, events } = memoryLogger();
    const provider: FlagProvider = {
      name: "fallback-reasons",
      capabilities() {
        return { static: true, streaming: false, targeting: false };
      },
      async resolve(request) {
        if (request.flagKey === "checkoutEnabled") {
          return { value: false, reason: "DISABLED" };
        }
        return { value: "light", reason: "ERROR", errorCode: "PROVIDER" };
      },
    };
    const client = createFlagsClient({
      schema,
      logger,
      provider,
      cacheTtlMs: 60_000,
      clock: fixedClock("2026-08-15T12:00:00.000Z"),
    });
    await client.evaluate("checkoutEnabled", { targetingKey: "user-1" });
    await client.evaluate("checkoutEnabled", { targetingKey: "user-1" });
    await client.evaluate("theme", { targetingKey: "user-1" });
    await client.evaluate("theme", { targetingKey: "user-1" });
    const fallbacks = events.filter(
      (event) => event.message === "flags.fallback",
    );
    expect(fallbacks).toHaveLength(4);
    expect(fallbacks.map((event) => event.fields?.reason)).toEqual([
      "DISABLED",
      "DISABLED",
      "ERROR",
      "ERROR",
    ]);
  });

  it("keeps omitted tenant distinct from an empty tenant", async () => {
    const seen: EvaluationContext[] = [];
    const { logger } = memoryLogger();
    const provider: FlagProvider = {
      name: "tenant-aware",
      capabilities() {
        return { static: true, streaming: false, targeting: true };
      },
      async resolve(request) {
        seen.push(request.context);
        return {
          value: request.context.tenant === undefined ? "absent" : "empty",
          reason: "TARGETING_MATCH",
        };
      },
    };
    const client = createFlagsClient({
      schema,
      logger,
      provider,
      cacheTtlMs: 60_000,
      clock: fixedClock("2026-08-15T12:00:00.000Z"),
    });
    const omitted = await client.evaluate("theme", { targetingKey: "user-1" });
    const empty = await client.evaluate("theme", {
      targetingKey: "user-1",
      tenant: "",
    });
    expect(omitted.value).toBe("absent");
    expect(empty.value).toBe("empty");
    expect(seen).toHaveLength(2);
  });

  it("does not let separator characters collide cache identities", () => {
    const left = cacheIdentity("theme", {
      targetingKey: "a\u001fb",
      tenant: "c",
    });
    const right = cacheIdentity("theme", {
      targetingKey: "a",
      tenant: "b\u001fc",
    });
    expect(left).not.toBe(right);
  });

  it("keeps omitted environment distinct from an empty environment", () => {
    const omitted = cacheIdentity("theme", { targetingKey: "user-1" });
    const empty = cacheIdentity("theme", {
      targetingKey: "user-1",
      environment: "",
    });
    expect(omitted).not.toBe(empty);
  });

  it("sanitizes provider errorMessage on a successful resolution", async () => {
    const { logger } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      cacheTtlMs: 0,
      provider: staticProvider(
        { checkoutEnabled: false },
        {
          reason: "ERROR",
          errorMessage: "first line\r\nfake: forged " + "x".repeat(400),
        },
      ),
    });
    const detail = await client.evaluate("checkoutEnabled", {
      targetingKey: "user-1",
    });
    expect(detail.reason).toBe("ERROR");
    expect(detail.errorMessage).toBeTypeOf("string");
    expect(detail.errorMessage).not.toMatch(/[\u0000-\u001F\u007F]/);
    expect(detail.errorMessage?.length).toBe(303);
    expect(detail.errorMessage?.endsWith("...")).toBe(true);
  });

  it("uses a type-mismatched provider value as ERROR", async () => {
    const { logger, events } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      cacheTtlMs: 0,
      provider: staticProvider({ checkoutEnabled: "yes" }),
    });
    const detail = await client.evaluate("checkoutEnabled", {
      targetingKey: "user-1",
    });
    expect(detail).toMatchObject({
      value: false,
      reason: "ERROR",
      errorCode: "PROVIDER",
    });
    expect(events.some((event) => event.message === "flags.fallback")).toBe(
      true,
    );
  });
});

describe("loggableError", () => {
  it("flattens control characters and caps length", () => {
    const logged = loggableError(
      new Error("first line\r\nfake: forged " + "x".repeat(400)),
    );
    expect(logged).not.toMatch(/[\u0000-\u001F\u007F]/);
    expect(logged.length).toBe(303);
    expect(logged.endsWith("...")).toBe(true);
  });
});
