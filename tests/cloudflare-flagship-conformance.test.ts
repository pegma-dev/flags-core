import { describe, it } from "vitest";

import type { EvaluationContext } from "../packages/flags-contracts/src/index.js";
import { flagConformanceCases } from "../packages/flags-core/src/conformance.js";
import {
  FLAGSHIP_REASON_DISABLED,
  FLAGSHIP_REASON_TARGETING_MATCH,
  createCloudflareFlagshipFlagProvider,
  type FlagshipEvaluationDetails,
  type FlagshipReader,
} from "../packages/flags-cloudflare-flagship/src/index.js";

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function detailFor(value: unknown): FlagshipEvaluationDetails {
  return {
    value,
    reason: FLAGSHIP_REASON_TARGETING_MATCH,
  };
}

function detailsFromFlags(
  flags: Readonly<Record<string, unknown>>,
): Record<string, FlagshipEvaluationDetails> {
  return Object.fromEntries(
    Object.entries(flags).map(([flagKey, value]) => [
      flagKey,
      detailFor(value),
    ]),
  );
}

function memoryReader(options: {
  readonly details?: Readonly<Record<string, FlagshipEvaluationDetails>>;
  readonly detailsForContext?: (
    context: EvaluationContext,
  ) => Readonly<Record<string, FlagshipEvaluationDetails>>;
  readonly delayMs?: number;
  readonly error?: unknown;
}): FlagshipReader {
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
      return createCloudflareFlagshipFlagProvider({
        reader: memoryReader({ details: detailsFromFlags(scenario.flags) }),
      });
    case "empty":
      return createCloudflareFlagshipFlagProvider({
        reader: memoryReader({ details: {} }),
      });
    case "targeted":
      return createCloudflareFlagshipFlagProvider({
        reader: memoryReader({
          detailsForContext(context) {
            return context.targetingKey === scenario.targetingKey
              ? detailsFromFlags(scenario.flags)
              : {};
          },
        }),
      });
    case "timeout":
      return createCloudflareFlagshipFlagProvider({
        reader: memoryReader({ delayMs: scenario.delayMs }),
      });
    case "error":
      return createCloudflareFlagshipFlagProvider({
        reader: memoryReader({ error: scenario.error }),
      });
    case "disabled":
      return createCloudflareFlagshipFlagProvider({
        reader: memoryReader({
          details: {
            [scenario.flagKey]: {
              value: scenario.value,
              reason: FLAGSHIP_REASON_DISABLED,
            },
          },
        }),
      });
  }
});

describe("Cloudflare Flagship provider conformance", () => {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});
