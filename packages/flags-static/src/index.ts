import type {
  EvaluationContext,
  FlagChangeEvent,
  FlagProvider,
  FlagProviderCapabilities,
  FlagResolution,
  FlagResolutionRequest,
} from "@pegma/flags-contracts";

export interface StaticFlagValue {
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly variant?: string;
}

export type StaticFlagMap = Readonly<Record<string, unknown | StaticFlagValue>>;

export interface StaticFlagProviderOptions {
  readonly name?: string;
  readonly flags?: StaticFlagMap;
  readonly flagsForContext?: (context: EvaluationContext) => StaticFlagMap;
  readonly delayMs?: number;
  readonly error?: unknown;
}

function isStaticFlagValue(value: unknown): value is StaticFlagValue {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "value") &&
    (Object.hasOwn(value, "disabled") || Object.hasOwn(value, "variant"))
  );
}

function resolveEntry(
  request: FlagResolutionRequest,
  flags: StaticFlagMap,
): FlagResolution {
  if (!Object.hasOwn(flags, request.flagKey)) {
    return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
  }
  const entry = flags[request.flagKey];
  if (isStaticFlagValue(entry)) {
    if (entry.disabled === true) {
      return {
        value: entry.value,
        reason: "DISABLED",
        ...(entry.variant === undefined ? {} : { variant: entry.variant }),
      };
    }
    return {
      value: entry.value,
      reason: "TARGETING_MATCH",
      ...(entry.variant === undefined ? {} : { variant: entry.variant }),
    };
  }
  return { value: entry, reason: "TARGETING_MATCH" };
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Zero-dep in-memory provider. Targeting, when present, is a host-supplied
 * map lookup — not a rule language.
 */
export function createStaticFlagProvider(
  options: StaticFlagProviderOptions = {},
): FlagProvider {
  const name = options.name ?? "static";
  const listeners = new Set<(event: FlagChangeEvent) => void>();
  const capabilities: FlagProviderCapabilities = {
    static: true,
    streaming: false,
    targeting: options.flagsForContext !== undefined,
  };

  return {
    name,
    capabilities() {
      return capabilities;
    },
    async resolve(request) {
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await wait(options.delayMs);
      }
      if (options.error !== undefined) {
        throw options.error;
      }
      const flags =
        options.flagsForContext?.(request.context) ?? options.flags ?? {};
      return resolveEntry(request, flags);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
