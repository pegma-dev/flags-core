import { describe, it } from "vitest";

import { flagConformanceCases } from "../packages/flags-core/src/conformance.js";
import {
  createStaticFlagProvider,
  staticFlag,
} from "../packages/flags-static/src/index.js";

const cases = flagConformanceCases((scenario) => {
  switch (scenario.type) {
    case "values":
      return createStaticFlagProvider({ flags: scenario.flags });
    case "empty":
      return createStaticFlagProvider({ flags: {} });
    case "targeted":
      return createStaticFlagProvider({
        flagsForContext(context) {
          return context.targetingKey === scenario.targetingKey
            ? scenario.flags
            : {};
        },
      });
    case "timeout":
      return createStaticFlagProvider({ delayMs: scenario.delayMs });
    case "error":
      return createStaticFlagProvider({ error: scenario.error });
    case "disabled":
      return createStaticFlagProvider({
        flags: {
          [scenario.flagKey]: staticFlag({
            value: scenario.value,
            disabled: true,
          }),
        },
      });
  }
});

describe("static provider conformance", () => {
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await testCase.run();
    });
  }
});
