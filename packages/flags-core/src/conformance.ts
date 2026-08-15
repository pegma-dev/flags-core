import type { FlagProvider } from "@pegma/flags-contracts";
import type { Logger } from "@pegma/spine";

import { createFlagsClient } from "./client.js";
import { declareFlags, flag } from "./schema.js";

export type ConformanceScenario =
  | {
      readonly type: "values";
      readonly flags: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "empty" }
  | {
      readonly type: "targeted";
      readonly targetingKey: string;
      readonly flags: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "timeout"; readonly delayMs: number }
  | { readonly type: "error"; readonly error: Error }
  | {
      readonly type: "disabled";
      readonly flagKey: string;
      readonly value: unknown;
    };

export interface ConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

function fail(message: string): never {
  throw new Error(message);
}

function assertEqual(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function createMemoryLogger(): {
  logger: Logger;
  events: Array<{
    readonly level: string;
    readonly message: string;
    readonly fields?: Readonly<Record<string, unknown>>;
  }>;
} {
  const events: Array<{
    readonly level: string;
    readonly message: string;
    readonly fields?: Readonly<Record<string, unknown>>;
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

const schema = declareFlags({
  checkoutEnabled: flag.boolean({ defaultValue: false }),
  theme: flag.string({ defaultValue: "light" }),
  maxItems: flag.number({ defaultValue: 10 }),
  payload: flag.json({ defaultValue: { experiment: "off" } }),
});

/**
 * Adapter-agnostic cases every {@link FlagProvider} must pass through
 * {@link createFlagsClient}. The factory receives the scenario the case
 * needs; it must not invent targeting rules in the core.
 */
export function flagConformanceCases(
  createProvider: (scenario: ConformanceScenario) => FlagProvider,
): readonly ConformanceCase[] {
  return [
    {
      name: "evaluates a boolean flag",
      async run() {
        const client = createFlagsClient({
          schema,
          provider: createProvider({
            type: "values",
            flags: { checkoutEnabled: true },
          }),
        });
        const detail = await client.evaluate("checkoutEnabled", {
          targetingKey: "user-1",
        });
        assertEqual(detail.value, true, "boolean value");
        assertEqual(detail.reason, "TARGETING_MATCH", "boolean reason");
        assertEqual(detail.flagKey, "checkoutEnabled", "boolean key");
      },
    },
    {
      name: "evaluates a string flag",
      async run() {
        const client = createFlagsClient({
          schema,
          provider: createProvider({
            type: "values",
            flags: { theme: "dark" },
          }),
        });
        const detail = await client.evaluate("theme", {
          targetingKey: "user-1",
        });
        assertEqual(detail.value, "dark", "string value");
        assertEqual(detail.reason, "TARGETING_MATCH", "string reason");
      },
    },
    {
      name: "evaluates a number flag",
      async run() {
        const client = createFlagsClient({
          schema,
          provider: createProvider({
            type: "values",
            flags: { maxItems: 25 },
          }),
        });
        const detail = await client.evaluate("maxItems", {
          targetingKey: "user-1",
        });
        assertEqual(detail.value, 25, "number value");
        assertEqual(detail.reason, "TARGETING_MATCH", "number reason");
      },
    },
    {
      name: "evaluates a json flag",
      async run() {
        const client = createFlagsClient({
          schema,
          provider: createProvider({
            type: "values",
            flags: { payload: { experiment: "on" } },
          }),
        });
        const detail = await client.evaluate("payload", {
          targetingKey: "user-1",
        });
        assertEqual(detail.value, { experiment: "on" }, "json value");
        assertEqual(detail.reason, "TARGETING_MATCH", "json reason");
      },
    },
    {
      name: "missing key returns DEFAULT_FALLBACK",
      async run() {
        const { logger, events } = createMemoryLogger();
        const client = createFlagsClient({
          schema,
          logger,
          provider: createProvider({ type: "empty" }),
        });
        const detail = await client.evaluate("checkoutEnabled", {
          targetingKey: "user-1",
        });
        assertEqual(detail.value, false, "missing default");
        assertEqual(detail.reason, "DEFAULT_FALLBACK", "missing reason");
        if (events.length === 0) {
          fail("missing key must log a fallback line");
        }
        assertEqual(events[0]?.message, "flags.fallback", "missing log");
      },
    },
    {
      name: "targeting key is visible to the provider",
      async run() {
        const client = createFlagsClient({
          schema,
          provider: createProvider({
            type: "targeted",
            targetingKey: "user-1",
            flags: { theme: "dark" },
          }),
        });
        const matched = await client.evaluate("theme", {
          targetingKey: "user-1",
        });
        assertEqual(matched.value, "dark", "targeted value");
        assertEqual(matched.reason, "TARGETING_MATCH", "targeted reason");
        const other = await client.evaluate("theme", {
          targetingKey: "user-2",
        });
        assertEqual(other.value, "light", "untargeted default");
        assertEqual(other.reason, "DEFAULT_FALLBACK", "untargeted reason");
      },
    },
    {
      name: "timeout returns ERROR and does not hang",
      async run() {
        const { logger, events } = createMemoryLogger();
        const client = createFlagsClient({
          schema,
          logger,
          timeoutMs: 20,
          cacheTtlMs: 0,
          provider: createProvider({ type: "timeout", delayMs: 200 }),
        });
        const detail = await client.evaluate("checkoutEnabled", {
          targetingKey: "user-1",
        });
        assertEqual(detail.value, false, "timeout default");
        assertEqual(detail.reason, "ERROR", "timeout reason");
        assertEqual(detail.errorCode, "TIMEOUT", "timeout code");
        if (!events.some((event) => event.message === "flags.fallback")) {
          fail("timeout must log a fallback line");
        }
      },
    },
    {
      name: "provider error returns ERROR",
      async run() {
        const { logger, events } = createMemoryLogger();
        const client = createFlagsClient({
          schema,
          logger,
          cacheTtlMs: 0,
          provider: createProvider({
            type: "error",
            error: new Error("provider unavailable"),
          }),
        });
        const detail = await client.evaluate("checkoutEnabled", {
          targetingKey: "user-1",
        });
        assertEqual(detail.value, false, "error default");
        assertEqual(detail.reason, "ERROR", "error reason");
        if (!events.some((event) => event.message === "flags.fallback")) {
          fail("provider error must log a fallback line");
        }
      },
    },
    {
      name: "does not silently fall back",
      async run() {
        const { logger, events } = createMemoryLogger();
        const client = createFlagsClient({
          schema,
          logger,
          provider: createProvider({ type: "empty" }),
        });
        const detail = await client.evaluate("theme", {
          targetingKey: "user-1",
        });
        if (detail.reason === undefined) {
          fail("fallback must include an evaluation reason");
        }
        if (events.length === 0) {
          fail("fallback must emit a log line");
        }
      },
    },
    {
      name: "disabled flags surface DISABLED",
      async run() {
        const { logger, events } = createMemoryLogger();
        const client = createFlagsClient({
          schema,
          logger,
          provider: createProvider({
            type: "disabled",
            flagKey: "checkoutEnabled",
            value: true,
          }),
        });
        const detail = await client.evaluate("checkoutEnabled", {
          targetingKey: "user-1",
        });
        assertEqual(detail.reason, "DISABLED", "disabled reason");
        assertEqual(detail.value, true, "disabled value");
        if (!events.some((event) => event.message === "flags.fallback")) {
          fail("disabled evaluation must log a fallback line");
        }
      },
    },
  ];
}
