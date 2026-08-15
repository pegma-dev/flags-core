import type { FlagProvider } from "@pegma/flags-contracts";

const DEFAULT_TIMEOUT_MS = 1_000;
const HEALTH_FLAG_KEY = "__pegma.flags.health__";

class ProbeTimeoutError extends Error {}

export interface FlagsHealthCheck {
  readonly name: string;
  run(): Promise<FlagsHealthCheckResult>;
}

export interface FlagsHealthCheckResult {
  readonly status: "ok" | "degraded" | "fail";
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly latencyMs?: number;
}

export interface FlagsHealthCheckOptions {
  readonly provider: FlagProvider;
  readonly name?: string;
  readonly timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ProbeTimeoutError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Structural {@link @pegma/health} check: the provider answered before the
 * timeout. Safe detail only — provider name and an enumerated reason.
 */
export function createFlagsHealthCheck(
  options: FlagsHealthCheckOptions,
): FlagsHealthCheck {
  const name = options.name ?? "flags";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name,
    async run() {
      const started = Date.now();
      try {
        const resolution = await withTimeout(
          options.provider.resolve({
            flagKey: HEALTH_FLAG_KEY,
            defaultValue: false,
            kind: "boolean",
            context: { targetingKey: "health" },
          }),
          timeoutMs,
        );
        return {
          status: "ok",
          latencyMs: Date.now() - started,
          detail: {
            provider: options.provider.name,
            reason: resolution.reason,
          },
        };
      } catch (error) {
        return {
          status: "fail",
          latencyMs: Date.now() - started,
          detail: {
            provider: options.provider.name,
            reason:
              error instanceof ProbeTimeoutError
                ? "probe_timeout"
                : "probe_failed",
          },
        };
      }
    },
  };
}
