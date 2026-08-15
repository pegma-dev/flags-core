import { fixedClock, type Logger } from "@pegma/spine";
import { describe, expect, it } from "vitest";

import { createFlagsClient, loggableError } from "./client.js";
import { declareFlags, flag } from "./schema.js";
import type { FlagProvider, FlagResolution } from "@pegma/flags-contracts";

const schema = declareFlags({
  checkoutEnabled: flag.boolean({ defaultValue: false }),
  theme: flag.string({ defaultValue: "light" }),
});

function memoryLogger(): {
  logger: Logger;
  events: Array<{ level: string; message: string }>;
} {
  const events: Array<{ level: string; message: string }> = [];
  return {
    events,
    logger: {
      log(level, message) {
        events.push({ level, message });
      },
    },
  };
}

function staticProvider(
  flags: Readonly<Record<string, unknown>>,
  extras: {
    readonly delayMs?: number;
    readonly reason?: FlagResolution["reason"];
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
        };
      }
      return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
    },
  };
}

describe("createFlagsClient", () => {
  it("rejects an empty targeting key", async () => {
    const client = createFlagsClient({
      schema,
      provider: staticProvider({}),
    });
    await expect(
      client.evaluate("checkoutEnabled", { targetingKey: "" }),
    ).rejects.toThrow("targetingKey");
  });

  it("returns a fresh cache hit with the original reason", async () => {
    let resolves = 0;
    const provider: FlagProvider = {
      name: "counting",
      capabilities() {
        return { static: true, streaming: false, targeting: false };
      },
      async resolve(request) {
        resolves += 1;
        return { value: true, reason: "TARGETING_MATCH" };
      },
    };
    const client = createFlagsClient({
      schema,
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
