import type {
  EvaluationContext,
  FlagChangeEvent,
  FlagProvider,
  FlagProviderCapabilities,
  FlagResolution,
  FlagResolutionRequest,
} from "@pegma/flags-contracts";

/** Distinguishes a static wrapper from a JSON payload that happens to use `value`. */
export const STATIC_FLAG_BRAND = Symbol.for("@pegma/flags-static");

export interface StaticFlagValue {
  readonly [STATIC_FLAG_BRAND]: true;
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

export function staticFlag(options: {
  readonly value: unknown;
  readonly disabled?: boolean;
  readonly variant?: string;
}): StaticFlagValue {
  return {
    [STATIC_FLAG_BRAND]: true,
    value: options.value,
    ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  };
}

function isStaticFlagValue(value: unknown): value is StaticFlagValue {
  return (
    value !== null &&
    typeof value === "object" &&
    STATIC_FLAG_BRAND in value &&
    (value as StaticFlagValue)[STATIC_FLAG_BRAND] === true
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
