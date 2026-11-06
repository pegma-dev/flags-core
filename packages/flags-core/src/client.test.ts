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

  it("requires a schema entry to be an own property", async () => {
    const inherited = {
      inherited: flag.boolean({ defaultValue: false }),
    };
    const inheritedSchema = Object.create(inherited) as typeof schema;
    Object.assign(inheritedSchema, schema);
    const { logger } = memoryLogger();
    const client = createFlagsClient({
      schema: inheritedSchema,
      logger,
      provider: staticProvider({ inherited: true }),
    });
    await expect(
      client.evaluate("inherited" as keyof typeof schema, {
        targetingKey: "user-1",
      }),
    ).rejects.toThrow("unknown flag");
  });

  it("validates the cache entry limit", () => {
    const { logger } = memoryLogger();
    expect(() =>
      createFlagsClient({
        schema,
        logger,
        provider: staticProvider({}),
        maxCacheEntries: -1,
      }),
    ).toThrow("non-negative integer");
    expect(() =>
      createFlagsClient({
        schema,
        logger,
        provider: staticProvider({}),
        maxCacheEntries: 1.5,
      }),
    ).toThrow("non-negative integer");
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

  it("covers every context field and canonicalizes attributes", () => {
    const base = {
      targetingKey: "user-1",
      principalId: "principal-1" as NonNullable<
        EvaluationContext["principalId"]
      >,
      tenant: "tenant-1",
      environment: "production",
      attributes: { beta: 2, alpha: "one" },
    } satisfies EvaluationContext;
    const reordered = {
      ...base,
      attributes: { alpha: "one", beta: 2 },
    } satisfies EvaluationContext;
    expect(cacheIdentity("theme", base)).toBe(
      cacheIdentity("theme", reordered),
    );
    expect(cacheIdentity("other", base)).not.toBe(cacheIdentity("theme", base));
    const { principalId: _principalId, ...withoutPrincipal } = base;
    expect(cacheIdentity("theme", withoutPrincipal)).not.toBe(
      cacheIdentity("theme", base),
    );
    expect(cacheIdentity("theme", { ...base, tenant: "other" })).not.toBe(
      cacheIdentity("theme", base),
    );
    expect(
      cacheIdentity("theme", { ...base, environment: "staging" }),
    ).not.toBe(cacheIdentity("theme", base));
    expect(
      cacheIdentity("theme", { ...base, attributes: { alpha: "one" } }),
    ).not.toBe(cacheIdentity("theme", base));
  });

  it("skips caching oversized identities", async () => {
    let resolves = 0;
    const { logger } = memoryLogger();
    const provider: FlagProvider = {
      name: "counting",
      capabilities() {
        return { static: true, streaming: false, targeting: true };
      },
      async resolve() {
        resolves += 1;
        return { value: "dark", reason: "TARGETING_MATCH" };
      },
    };
    const context = {
      targetingKey: "user-1",
      attributes: { note: "x".repeat(9_000) },
    } satisfies EvaluationContext;
    expect(cacheIdentity("theme", context)).toBeUndefined();
    const client = createFlagsClient({ schema, logger, provider });
    await client.evaluate("theme", context);
    await client.evaluate("theme", context);
    expect(resolves).toBe(2);
  });

  it("does not partially encode non-standard attributes", () => {
    const nonEnumerable: Record<string, string> = {};
    Object.defineProperty(nonEnumerable, "hidden", {
      value: "one",
      enumerable: false,
    });
    expect(
      cacheIdentity("theme", {
        targetingKey: "user-1",
        attributes: nonEnumerable,
      }),
    ).not.toBe(
      cacheIdentity("theme", {
        targetingKey: "user-1",
        attributes: {},
      }),
    );

    const sparse: unknown[] = [];
    sparse[1] = "one";
    expect(
      cacheIdentity("theme", {
        targetingKey: "user-1",
        attributes: {
          sparse,
        } as NonNullable<EvaluationContext["attributes"]>,
      }),
    ).toBeUndefined();
  });

  it("skips caching oversized values", async () => {
    let resolves = 0;
    const { logger } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      provider: {
        name: "large-value",
        capabilities() {
          return { static: true, streaming: false, targeting: false };
        },
        async resolve() {
          resolves += 1;
          return { value: "x".repeat(70_000), reason: "TARGETING_MATCH" };
        },
      },
    });
    await client.evaluate("theme", { targetingKey: "user-1" });
    await client.evaluate("theme", { targetingKey: "user-1" });
    expect(resolves).toBe(2);
  });

  it("evicts the least recently used cache entry", async () => {
    let resolves = 0;
    const { logger } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      maxCacheEntries: 2,
      cacheTtlMs: 60_000,
      provider: {
        name: "context-value",
        capabilities() {
          return { static: true, streaming: false, targeting: true };
        },
        async resolve(request) {
          resolves += 1;
          return {
            value: request.context.targetingKey,
            reason: "TARGETING_MATCH",
          };
        },
      },
    });
    await client.evaluate("theme", { targetingKey: "user-1" });
    await client.evaluate("theme", { targetingKey: "user-2" });
    await client.evaluate("theme", { targetingKey: "user-1" });
    await client.evaluate("theme", { targetingKey: "user-3" });
    await client.evaluate("theme", { targetingKey: "user-2" });
    expect(resolves).toBe(4);
  });

  it("treats a zero cache entry limit as disabled", async () => {
    let resolves = 0;
    const { logger } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      maxCacheEntries: 0,
      provider: {
        name: "counting",
        capabilities() {
          return { static: true, streaming: false, targeting: false };
        },
        async resolve() {
          resolves += 1;
          return { value: true, reason: "TARGETING_MATCH" };
        },
      },
    });
    await client.evaluate("checkoutEnabled", { targetingKey: "user-1" });
    await client.evaluate("checkoutEnabled", { targetingKey: "user-1" });
    expect(resolves).toBe(2);
  });

  it("coalesces concurrent cache misses", async () => {
    let resolves = 0;
    let complete: ((resolution: FlagResolution) => void) | undefined;
    const pending = new Promise<FlagResolution>((resolve) => {
      complete = resolve;
    });
    const { logger } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      provider: {
        name: "deferred",
        capabilities() {
          return { static: true, streaming: false, targeting: false };
        },
        resolve() {
          resolves += 1;
          return pending;
        },
      },
    });
    const first = client.evaluate("checkoutEnabled", {
      targetingKey: "user-1",
    });
    const second = client.evaluate("checkoutEnabled", {
      targetingKey: "user-1",
    });
    await Promise.resolve();
    complete?.({ value: true, reason: "TARGETING_MATCH" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ value: true }),
      expect.objectContaining({ value: true }),
    ]);
    expect(resolves).toBe(1);
  });

  it("aborts timed out work and keeps it coalesced until settlement", async () => {
    let resolves = 0;
    let signal: AbortSignal | undefined;
    let complete: ((resolution: FlagResolution) => void) | undefined;
    const pending = new Promise<FlagResolution>((resolve) => {
      complete = resolve;
    });
    const { logger } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      timeoutMs: 10,
      provider: {
        name: "deferred",
        capabilities() {
          return { static: true, streaming: false, targeting: false };
        },
        resolve(request) {
          resolves += 1;
          signal = request.signal;
          return pending;
        },
      },
    });
    await expect(
      client.evaluate("checkoutEnabled", { targetingKey: "user-1" }),
    ).resolves.toMatchObject({ reason: "ERROR", errorCode: "TIMEOUT" });
    expect(signal?.aborted).toBe(true);
    await expect(
      client.evaluate("checkoutEnabled", { targetingKey: "user-1" }),
    ).resolves.toMatchObject({ reason: "ERROR", errorCode: "TIMEOUT" });
    expect(resolves).toBe(1);
    complete?.({ value: true, reason: "TARGETING_MATCH" });
    await Promise.resolve();
  });

  it("bounds unresolved provider calls", async () => {
    let resolves = 0;
    const { logger } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      timeoutMs: 5,
      provider: {
        name: "pending",
        capabilities() {
          return { static: true, streaming: false, targeting: true };
        },
        resolve() {
          resolves += 1;
          return new Promise(() => {
            // Remains pending for this check.
          });
        },
      },
    });
    const results = await Promise.all(
      Array.from({ length: 129 }, (_, index) =>
        client.evaluate("checkoutEnabled", {
          targetingKey: `user-${String(index)}`,
        }),
      ),
    );
    expect(resolves).toBe(128);
    expect(
      results.filter(({ errorCode }) => errorCode === "CAPACITY"),
    ).toHaveLength(1);
    expect(
      results.filter(({ errorCode }) => errorCode === "TIMEOUT"),
    ).toHaveLength(128);
    await client.close();
  });

  it("omits targeting keys from client log fields", async () => {
    let current = "2026-08-15T12:00:00.000Z";
    let resolves = 0;
    const { logger, events } = memoryLogger();
    const client = createFlagsClient({
      schema,
      logger,
      clock: { now: () => current },
      cacheTtlMs: 1,
      staleWhileRevalidateMs: 60_000,
      provider: {
        name: "then-fail",
        capabilities() {
          return { static: true, streaming: false, targeting: false };
        },
        async resolve() {
          resolves += 1;
          if (resolves === 1) {
            return { value: "dark", reason: "DEFAULT_FALLBACK" };
          }
          throw new Error("provider unavailable");
        },
      },
    });
    await client.evaluate("theme", { targetingKey: "private-key" });
    current = "2026-08-15T12:00:01.000Z";
    await client.evaluate("theme", { targetingKey: "private-key" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(events).not.toHaveLength(0);
    expect(events.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        "flags.fallback",
        "flags.stale_cache",
        "flags.refresh_failed",
      ]),
    );
    for (const event of events) {
      expect(event.fields).not.toHaveProperty("targetingKey");
      expect(JSON.stringify(event.fields)).not.toContain("private-key");
    }
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
