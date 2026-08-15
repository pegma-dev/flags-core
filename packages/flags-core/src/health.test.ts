import { describe, expect, it } from "vitest";

import { createFlagsHealthCheck } from "./health.js";
import type { FlagProvider } from "@pegma/flags-contracts";

function okProvider(): FlagProvider {
  return {
    name: "static",
    capabilities() {
      return { static: true, streaming: false, targeting: false };
    },
    async resolve(request) {
      return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
    },
  };
}

describe("createFlagsHealthCheck", () => {
  it("reports ok when the provider settles", async () => {
    const check = createFlagsHealthCheck({ provider: okProvider() });
    const result = await check.run();
    expect(result.status).toBe("ok");
    expect(result.detail).toEqual({
      provider: "static",
      reason: "DEFAULT_FALLBACK",
    });
  });

  it("reports fail on timeout without leaking error text", async () => {
    const hanging: FlagProvider = {
      name: "hanging",
      capabilities() {
        return { static: true, streaming: false, targeting: false };
      },
      resolve() {
        return new Promise(() => {
          // never settles
        });
      },
    };
    const result = await createFlagsHealthCheck({
      provider: hanging,
      timeoutMs: 15,
    }).run();
    expect(result.status).toBe("fail");
    expect(result.detail).toEqual({
      provider: "hanging",
      reason: "probe_timeout",
    });
    expect(JSON.stringify(result)).not.toContain("timed out");
  });
});
