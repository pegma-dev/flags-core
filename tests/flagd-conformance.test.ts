import { describe, it } from "vitest";

import type { EvaluationContext } from "../packages/flags-contracts/src/index.js";
import { flagConformanceCases } from "../packages/flags-core/src/conformance.js";
import {
  FLAGD_REASON_DISABLED,
  FLAGD_REASON_TARGETING_MATCH,
  createFlagdFlagProvider,
  type FlagdEvaluationDetails,
  type FlagdReader,
} from "../packages/flags-flagd/src/index.js";

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function detailFor(value: unknown): FlagdEvaluationDetails {
  return {
    value,
    reason: FLAGD_REASON_TARGETING_MATCH,
  };
}

function detailsFromFlags(
  flags: Readonly<Record<string, unknown>>,
): Record<string, FlagdEvaluationDetails> {
  return Object.fromEntries(
    Object.entries(flags).map(([flagKey, value]) => [
      flagKey,
      detailFor(value),
    ]),
  );
}

function memoryReader(options: {
  readonly details?: Readonly<Record<string, FlagdEvaluationDetails>>;
  readonly detailsForContext?: (
    context: EvaluationContext,
  ) => Readonly<Record<string, FlagdEvaluationDetails>>;
  readonly delayMs?: number;
  readonly error?: unknown;
}): FlagdReader {
  return {
    async getDetails(request) {
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await wait(options.delayMs);
      }
      if (options.error !== undefined) {
        throw options.error;
      }
      const details =
        options.detailsForContext?.(request.context) ?? options.details ?? {};
      return Object.hasOwn(details, request.flagKey)
        ? details[request.flagKey]
        : undefined;
    },
  };
}

const cases = flagConformanceCases((scenario) => {
  switch (scenario.type) {
    case "values":
      return createFlagdFlagProvider({
        reader: memoryReader({ details: detailsFromFlags(scenario.flags) }),
      });
    case "empty":
      return createFlagdFlagProvider({
        reader: memoryReader({ details: {} }),
      });
    case "targeted":
      return createFlagdFlagProvider({
        reader: memoryReader({
          detailsForContext(context) {
            return context.targetingKey === scenario.targetingKey
              ? detailsFromFlags(scenario.flags)
              : {};
          },
        }),
      });
    case "timeout":
      return createFlagdFlagProvider({
        reader: memoryReader({ delayMs: scenario.delayMs }),
      });
    case "error":
      return createFlagdFlagProvider({
        reader: memoryReader({ error: scenario.error }),
      });
    case "disabled":
      return createFlagdFlagProvider({
        reader: memoryReader({
          details: {
            [scenario.flagKey]: {
              value: scenario.value,
              reason: FLAGD_REASON_DISABLED,
            },
          },
        }),
      });
  }
});

describe("flagd provider conformance", () => {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});
