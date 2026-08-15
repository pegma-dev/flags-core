import { describe, it } from "vitest";

import type { EvaluationContext } from "../packages/flags-contracts/src/index.js";
import { flagConformanceCases } from "../packages/flags-core/src/conformance.js";
import {
  createAwsAppConfigFlagProvider,
  type AwsAppConfigConfiguration,
  type AwsAppConfigReader,
} from "../packages/flags-aws-appconfig/src/index.js";

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function configurationsFromFlags(
  flags: Readonly<Record<string, unknown>>,
): AwsAppConfigConfiguration[] {
  return Object.entries(flags).map(([flagKey, value]) => ({
    key: flagKey,
    value,
  }));
}

function memoryReader(options: {
  readonly configurations?: readonly AwsAppConfigConfiguration[];
  readonly configurationsForContext?: (
    context: EvaluationContext,
  ) => readonly AwsAppConfigConfiguration[];
  readonly delayMs?: number;
  readonly error?: unknown;
}): AwsAppConfigReader {
  return {
    async getConfiguration(request) {
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await wait(options.delayMs);
      }
      if (options.error !== undefined) {
        throw options.error;
      }
      const configurations =
        options.configurationsForContext?.(request.context) ??
        options.configurations ??
        [];
      return configurations.find(
        (configuration) => configuration.key === request.key,
      );
    },
  };
}

const cases = flagConformanceCases((scenario) => {
  switch (scenario.type) {
    case "values":
      return createAwsAppConfigFlagProvider({
        reader: memoryReader({
          configurations: configurationsFromFlags(scenario.flags),
        }),
      });
    case "empty":
      return createAwsAppConfigFlagProvider({
        reader: memoryReader({ configurations: [] }),
      });
    case "targeted":
      return createAwsAppConfigFlagProvider({
        reader: memoryReader({
          configurationsForContext(context) {
            return context.targetingKey === scenario.targetingKey
              ? configurationsFromFlags(scenario.flags)
              : [];
          },
        }),
      });
    case "timeout":
      return createAwsAppConfigFlagProvider({
        reader: memoryReader({ delayMs: scenario.delayMs }),
      });
    case "error":
      return createAwsAppConfigFlagProvider({
        reader: memoryReader({ error: scenario.error }),
      });
    case "disabled":
      return createAwsAppConfigFlagProvider({
        reader: memoryReader({
          configurations: [
            {
              key: scenario.flagKey,
              value: {
                enabled: false,
                _variants: [
                  {
                    name: "stored",
                    enabled: scenario.value,
                  },
                ],
              },
            },
          ],
        }),
      });
  }
});

describe("AWS AppConfig provider conformance", () => {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});
