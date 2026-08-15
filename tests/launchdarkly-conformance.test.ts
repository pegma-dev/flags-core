import { describe, it } from "vitest";

import type { EvaluationContext } from "../packages/flags-contracts/src/index.js";
import { flagConformanceCases } from "../packages/flags-core/src/conformance.js";
import {
  LAUNCHDARKLY_REASON_OFF,
  LAUNCHDARKLY_REASON_TARGET_MATCH,
  createLaunchDarklyFlagProvider,
  type LaunchDarklyEvaluationDetail,
  type LaunchDarklyReader,
} from "../packages/flags-launchdarkly/src/index.js";

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function detailFor(value: unknown): LaunchDarklyEvaluationDetail {
  return {
    value,
    reason: { kind: LAUNCHDARKLY_REASON_TARGET_MATCH },
  };
}

function detailsFromFlags(
  flags: Readonly<Record<string, unknown>>,
): Record<string, LaunchDarklyEvaluationDetail> {
  return Object.fromEntries(
    Object.entries(flags).map(([flagKey, value]) => [
      flagKey,
      detailFor(value),
    ]),
  );
}

function memoryReader(options: {
  readonly details?: Readonly<Record<string, LaunchDarklyEvaluationDetail>>;
  readonly detailsForContext?: (
    context: EvaluationContext,
  ) => Readonly<Record<string, LaunchDarklyEvaluationDetail>>;
  readonly delayMs?: number;
  readonly error?: unknown;
}): LaunchDarklyReader {
  return {
    async variationDetail(request) {
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
      return createLaunchDarklyFlagProvider({
        reader: memoryReader({ details: detailsFromFlags(scenario.flags) }),
      });
    case "empty":
      return createLaunchDarklyFlagProvider({
        reader: memoryReader({ details: {} }),
      });
    case "targeted":
      return createLaunchDarklyFlagProvider({
        reader: memoryReader({
          detailsForContext(context) {
            return context.targetingKey === scenario.targetingKey
              ? detailsFromFlags(scenario.flags)
              : {};
          },
        }),
      });
    case "timeout":
      return createLaunchDarklyFlagProvider({
        reader: memoryReader({ delayMs: scenario.delayMs }),
      });
    case "error":
      return createLaunchDarklyFlagProvider({
        reader: memoryReader({ error: scenario.error }),
      });
    case "disabled":
      return createLaunchDarklyFlagProvider({
        reader: memoryReader({
          details: {
            [scenario.flagKey]: {
              value: scenario.value,
              reason: { kind: LAUNCHDARKLY_REASON_OFF },
            },
          },
        }),
      });
  }
});

describe("LaunchDarkly provider conformance", () => {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});
