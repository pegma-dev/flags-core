import type { FlagValueKind, JsonValue } from "@pegma/flags-contracts";

/** One host-declared flag and the runtime codec for its kind. */
export interface FlagDefinition<T> {
  readonly kind: FlagValueKind;
  readonly defaultValue: T;
  readonly description?: string;
  readonly decode?: (raw: unknown) => T;
}

export type FlagSchema = Record<string, FlagDefinition<unknown>>;

export type FlagValueOf<TDefinition> =
  TDefinition extends FlagDefinition<infer TValue> ? TValue : never;

export interface BooleanFlagOptions {
  readonly defaultValue: boolean;
  readonly description?: string;
}

export interface StringFlagOptions {
  readonly defaultValue: string;
  readonly description?: string;
}

export interface NumberFlagOptions {
  readonly defaultValue: number;
  readonly description?: string;
}

export interface JsonFlagOptions<T> {
  readonly defaultValue: T;
  readonly description?: string;
  readonly decode?: (raw: unknown) => T;
}

function withDescription<T extends object>(
  definition: T,
  description: string | undefined,
): T {
  return description === undefined
    ? definition
    : { ...definition, description };
}

function requireKind(
  kind: FlagValueKind,
  value: unknown,
  flagKey: string,
): void {
  switch (kind) {
    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(`flag ${flagKey} defaultValue must be a boolean`);
      }
      return;
    case "string":
      if (typeof value !== "string") {
        throw new Error(`flag ${flagKey} defaultValue must be a string`);
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`flag ${flagKey} defaultValue must be a finite number`);
      }
      return;
    case "json":
      if (!isJsonValue(value)) {
        throw new Error(`flag ${flagKey} defaultValue must be JSON-compatible`);
      }
  }
}

/** True when `value` can round-trip through JSON. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") {
    return true;
  }
  if (kind === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (kind === "object") {
    return Object.values(value as Record<string, unknown>).every((entry) =>
      isJsonValue(entry),
    );
  }
  return false;
}

export const flag = {
  boolean(options: BooleanFlagOptions): FlagDefinition<boolean> {
    return withDescription(
      { kind: "boolean", defaultValue: options.defaultValue },
      options.description,
    );
  },
  string(options: StringFlagOptions): FlagDefinition<string> {
    return withDescription(
      { kind: "string", defaultValue: options.defaultValue },
      options.description,
    );
  },
  number(options: NumberFlagOptions): FlagDefinition<number> {
    return withDescription(
      { kind: "number", defaultValue: options.defaultValue },
      options.description,
    );
  },
  json<T>(options: JsonFlagOptions<T>): FlagDefinition<T> {
    const definition: FlagDefinition<T> = withDescription(
      { kind: "json", defaultValue: options.defaultValue },
      options.description,
    );
    return options.decode === undefined
      ? definition
      : { ...definition, decode: options.decode };
  },
};

/**
 * Declares a typed flag map. The returned object is the compile-time schema
 * `createFlagsClient` infers from.
 */
export function declareFlags<
  const T extends Record<string, FlagDefinition<unknown>>,
>(flags: T): T {
  for (const [flagKey, definition] of Object.entries(flags)) {
    requireKind(definition.kind, definition.defaultValue, flagKey);
  }
  return flags;
}
