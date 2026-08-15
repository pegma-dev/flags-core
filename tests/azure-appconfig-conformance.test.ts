import { describe, it } from "vitest";

import type { EvaluationContext } from "@pegma/flags-contracts";
import { flagConformanceCases } from "../packages/flags-core/src/conformance.js";
import {
  AZURE_FEATURE_FLAG_CONTENT_TYPE,
  createAzureAppConfigFlagProvider,
  type AzureAppConfigurationReader,
  type AzureAppConfigurationSetting,
} from "../packages/flags-azure-appconfig/src/index.js";

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function settingFor(
  flagKey: string,
  value: unknown,
): AzureAppConfigurationSetting {
  if (typeof value === "string") {
    return { key: flagKey, value };
  }
  return { key: flagKey, value: JSON.stringify(value) };
}

function settingsFromFlags(
  flags: Readonly<Record<string, unknown>>,
): AzureAppConfigurationSetting[] {
  return Object.entries(flags).map(([flagKey, value]) =>
    settingFor(flagKey, value),
  );
}

function memoryReader(options: {
  readonly settings?: readonly AzureAppConfigurationSetting[];
  readonly settingsForContext?: (
    context: EvaluationContext,
  ) => readonly AzureAppConfigurationSetting[];
  readonly delayMs?: number;
  readonly error?: unknown;
}): AzureAppConfigurationReader {
  return {
    async getConfigurationSetting(request) {
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await wait(options.delayMs);
      }
      if (options.error !== undefined) {
        throw options.error;
      }
      const settings =
        options.settingsForContext?.(request.context) ?? options.settings ?? [];
      return settings.find((setting) => setting.key === request.key);
    },
  };
}

const cases = flagConformanceCases((scenario) => {
  switch (scenario.type) {
    case "values":
      return createAzureAppConfigFlagProvider({
        reader: memoryReader({ settings: settingsFromFlags(scenario.flags) }),
      });
    case "empty":
      return createAzureAppConfigFlagProvider({
        reader: memoryReader({ settings: [] }),
      });
    case "targeted":
      return createAzureAppConfigFlagProvider({
        reader: memoryReader({
          settingsForContext(context) {
            return context.targetingKey === scenario.targetingKey
              ? settingsFromFlags(scenario.flags)
              : [];
          },
        }),
      });
    case "timeout":
      return createAzureAppConfigFlagProvider({
        reader: memoryReader({ delayMs: scenario.delayMs }),
      });
    case "error":
      return createAzureAppConfigFlagProvider({
        reader: memoryReader({ error: scenario.error }),
      });
    case "disabled":
      return createAzureAppConfigFlagProvider({
        reader: memoryReader({
          settings: [
            {
              key: scenario.flagKey,
              value: JSON.stringify({
                id: scenario.flagKey,
                enabled: false,
                variants: [
                  {
                    name: "stored",
                    configuration_value: scenario.value,
                  },
                ],
                allocation: { default_when_disabled: "stored" },
              }),
              contentType: AZURE_FEATURE_FLAG_CONTENT_TYPE,
            },
          ],
        }),
      });
  }
});

describe("Azure App Configuration provider conformance", () => {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});
