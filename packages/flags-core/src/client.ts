import type {
  EvaluationContext,
  EvaluationDetail,
  EvaluationReason,
  FlagProvider,
  FlagResolution,
} from "@pegma/flags-contracts";
import { systemClock, type Clock, type Logger } from "@pegma/spine";

import {
  isJsonValue,
  type FlagDefinition,
  type FlagValueOf,
} from "./schema.js";

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_STALE_WHILE_REVALIDATE_MS = 30_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1_024;
const MAX_CACHE_IDENTITY_CHARS = 8_192;
const MAX_CACHED_VALUE_CHARS = 65_536;
const MAX_CANONICAL_ENTRIES = 4_096;
const MAX_IN_FLIGHT_PROVIDER_CALLS = 128;
const EXPIRED_SWEEP_LIMIT = 16;
const MAX_LOGGED_ERROR_CHARS = 300;
const UTF8_ENCODER = new TextEncoder();

class EvaluationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`flag evaluation timed out after ${timeoutMs}ms`);
    this.name = "EvaluationTimeoutError";
  }
}

class ProviderCapacityError extends Error {
  constructor() {
    super("flag provider concurrency limit reached");
    this.name = "ProviderCapacityError";
  }
}

class CacheEncodingError extends Error {}

interface CacheEntry {
  readonly flagKey: string;
  readonly value: unknown;
  readonly reason: EvaluationReason;
  readonly variant?: string;
  readonly storedAtMs: number;
}

interface ProviderWork {
  readonly controller: AbortController;
  readonly promise: Promise<FlagResolution>;
}

export interface FlagsClientOptions<
  TSchema extends Record<string, FlagDefinition<unknown>>,
> {
  readonly schema: TSchema;
  readonly provider: FlagProvider;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly staleWhileRevalidateMs?: number;
  readonly maxCacheEntries?: number;
}

export interface FlagsClient<
  TSchema extends Record<string, FlagDefinition<unknown>>,
> {
  evaluate<K extends keyof TSchema & string>(
    flagKey: K,
    context: EvaluationContext,
  ): Promise<EvaluationDetail<FlagValueOf<TSchema[K]>>>;
  get<K extends keyof TSchema & string>(
    flagKey: K,
    context: EvaluationContext,
  ): Promise<FlagValueOf<TSchema[K]>>;
  invalidate(flagKey?: string): void;
  close(): Promise<void>;
}

function nowMs(clock: Clock): number {
  const parsed = Date.parse(clock.now());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function requireTargetingKey(context: EvaluationContext): void {
  if (typeof context.targetingKey !== "string" || context.targetingKey === "") {
    throw new Error(
      "EvaluationContext.targetingKey must be a non-empty string",
    );
  }
}

function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (value === null) {
    return ["null"];
  }
  switch (typeof value) {
    case "boolean":
      return ["boolean", value];
    case "number":
      if (!Number.isFinite(value)) {
        throw new CacheEncodingError();
      }
      return ["number", Object.is(value, -0) ? "-0" : String(value)];
    case "string":
      return ["string", value];
    case "object": {
      if (seen.has(value)) {
        throw new CacheEncodingError();
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          if (
            value.length > MAX_CANONICAL_ENTRIES ||
            Object.getOwnPropertySymbols(value).length !== 0 ||
            Object.getOwnPropertyNames(value).some(
              (key) =>
                key !== "length" &&
                (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length),
            )
          ) {
            throw new CacheEncodingError();
          }
          const entries: unknown[] = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) {
              throw new CacheEncodingError();
            }
            entries.push(canonicalValue(value[index], seen));
          }
          return ["array", entries];
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new CacheEncodingError();
        }
        if (Object.getOwnPropertySymbols(value).length !== 0) {
          throw new CacheEncodingError();
        }
        const keys = Object.getOwnPropertyNames(value).sort();
        if (keys.length > MAX_CANONICAL_ENTRIES) {
          throw new CacheEncodingError();
        }
        return [
          "object",
          keys.map((key) => {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (descriptor === undefined || !("value" in descriptor)) {
              throw new CacheEncodingError();
            }
            return [["key", key], canonicalValue(descriptor.value, seen)];
          }),
        ];
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new CacheEncodingError();
  }
}

function optionalIdentityField(value: unknown): unknown {
  return value === undefined
    ? ["missing"]
    : ["present", canonicalValue(value, new Set())];
}

/**
 * Canonically encodes every provider-visible context field. Oversized or
 * non-serializable runtime input is deliberately not cacheable.
 */
export function cacheIdentity(
  flagKey: string,
  context: EvaluationContext,
): string | undefined {
  try {
    const identity = JSON.stringify([
      "flag-evaluation",
      ["flagKey", canonicalValue(flagKey, new Set())],
      ["targetingKey", canonicalValue(context.targetingKey, new Set())],
      ["principalId", optionalIdentityField(context.principalId)],
      ["tenant", optionalIdentityField(context.tenant)],
      ["environment", optionalIdentityField(context.environment)],
      ["attributes", optionalIdentityField(context.attributes)],
    ]);
    return UTF8_ENCODER.encode(identity).byteLength <= MAX_CACHE_IDENTITY_CHARS
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

function isCacheableValue(value: unknown): boolean {
  try {
    return (
      UTF8_ENCODER.encode(JSON.stringify(canonicalValue(value, new Set())))
        .byteLength <= MAX_CACHED_VALUE_CHARS
    );
  } catch {
    return false;
  }
}

function waitForProvider(
  work: ProviderWork,
  timeoutMs: number,
): Promise<FlagResolution> {
  return new Promise<FlagResolution>((resolve, reject) => {
    const timer = setTimeout(() => {
      work.controller.abort();
      reject(new EvaluationTimeoutError(timeoutMs));
    }, timeoutMs);
    work.promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          work.controller.signal.aborted
            ? new EvaluationTimeoutError(timeoutMs)
            : error,
        );
      },
    );
  });
}

/**
 * Error text is provider-supplied and may carry remote input, so control
 * characters are flattened and the string is capped before it reaches a
 * logger.
 */
export function loggableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const flattened = text.replace(/[\u0000-\u001F\u007F]/g, " ");
  return flattened.length > MAX_LOGGED_ERROR_CHARS
    ? `${flattened.slice(0, MAX_LOGGED_ERROR_CHARS)}...`
    : flattened;
}

function decodeFlagValue<T>(
  definition: FlagDefinition<T>,
  raw: unknown,
  flagKey: string,
): T {
  if (definition.decode !== undefined) {
    return definition.decode(raw);
  }
  switch (definition.kind) {
    case "boolean":
      if (typeof raw !== "boolean") {
        throw new Error(`flag ${flagKey} expected a boolean`);
      }
      return raw as T;
    case "string":
      if (typeof raw !== "string") {
        throw new Error(`flag ${flagKey} expected a string`);
      }
      return raw as T;
    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new Error(`flag ${flagKey} expected a finite number`);
      }
      return raw as T;
    case "json":
      if (!isJsonValue(raw)) {
        throw new Error(`flag ${flagKey} expected JSON-compatible value`);
      }
      return raw as T;
  }
}

function toDetail<T>(
  flagKey: string,
  value: T,
  reason: EvaluationReason,
  extras: {
    readonly variant?: string;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  } = {},
): EvaluationDetail<T> {
  return {
    flagKey,
    value,
    reason,
    ...(extras.variant === undefined ? {} : { variant: extras.variant }),
    ...(extras.errorCode === undefined ? {} : { errorCode: extras.errorCode }),
    ...(extras.errorMessage === undefined
      ? {}
      : { errorMessage: extras.errorMessage }),
  };
}

function logFallback(
  logger: Logger,
  reason: EvaluationReason,
  flagKey: string,
  error?: unknown,
): void {
  logger.log(reason === "ERROR" ? "warn" : "info", "flags.fallback", {
    flagKey,
    reason,
    ...(error === undefined ? {} : { error: loggableError(error) }),
  });
}

/** Constructs an injected evaluation client owned by the host. */
export function createFlagsClient<
  TSchema extends Record<string, FlagDefinition<unknown>>,
>(options: FlagsClientOptions<TSchema>): FlagsClient<TSchema> {
  if (
    options.logger === undefined ||
    typeof options.logger.log !== "function"
  ) {
    throw new Error("createFlagsClient requires an injected Logger");
  }
  const logger = options.logger;
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const staleWhileRevalidateMs =
    options.staleWhileRevalidateMs ?? DEFAULT_STALE_WHILE_REVALIDATE_MS;
  const maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 0) {
    throw new Error("maxCacheEntries must be a non-negative integer");
  }

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, ProviderWork>();
  const activeWorks = new Set<ProviderWork>();

  function readCache(
    identity: string | undefined,
    atMs: number,
  ): CacheEntry | undefined {
    if (identity === undefined || cacheTtlMs <= 0 || maxCacheEntries === 0) {
      return undefined;
    }
    const entry = cache.get(identity);
    if (entry === undefined) {
      return undefined;
    }
    const age = atMs - entry.storedAtMs;
    if (age >= cacheTtlMs + staleWhileRevalidateMs) {
      cache.delete(identity);
      return undefined;
    }
    cache.delete(identity);
    cache.set(identity, entry);
    return entry;
  }

  function sweepExpired(atMs: number): void {
    let examined = 0;
    for (const [identity, entry] of cache) {
      if (examined >= EXPIRED_SWEEP_LIMIT) {
        return;
      }
      examined += 1;
      if (atMs - entry.storedAtMs >= cacheTtlMs + staleWhileRevalidateMs) {
        cache.delete(identity);
      }
    }
  }

  function writeCache(
    identity: string | undefined,
    flagKey: string,
    value: unknown,
    resolution: FlagResolution,
    atMs: number,
  ): void {
    if (
      identity === undefined ||
      cacheTtlMs <= 0 ||
      maxCacheEntries === 0 ||
      !isCacheableValue(value)
    ) {
      return;
    }
    sweepExpired(atMs);
    cache.delete(identity);
    cache.set(identity, {
      flagKey,
      value,
      reason: resolution.reason,
      ...(resolution.variant === undefined
        ? {}
        : { variant: resolution.variant }),
      storedAtMs: atMs,
    });
    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }
  }

  function providerWork(
    identity: string | undefined,
    flagKey: string,
    definition: FlagDefinition<unknown>,
    context: EvaluationContext,
  ): ProviderWork {
    if (identity !== undefined) {
      const existing = inFlight.get(identity);
      if (existing !== undefined) {
        return existing;
      }
    }
    if (activeWorks.size >= MAX_IN_FLIGHT_PROVIDER_CALLS) {
      throw new ProviderCapacityError();
    }

    const controller = new AbortController();
    let work: ProviderWork;
    const promise = Promise.resolve().then(() =>
      options.provider.resolve({
        flagKey,
        defaultValue: definition.defaultValue,
        kind: definition.kind,
        context,
        signal: controller.signal,
      }),
    );
    work = { controller, promise };
    activeWorks.add(work);
    if (identity !== undefined) {
      inFlight.set(identity, work);
    }
    void promise.then(
      () => {
        activeWorks.delete(work);
        if (identity !== undefined && inFlight.get(identity) === work) {
          inFlight.delete(identity);
        }
      },
      () => {
        activeWorks.delete(work);
        if (identity !== undefined && inFlight.get(identity) === work) {
          inFlight.delete(identity);
        }
      },
    );
    return work;
  }

  function refresh(
    identity: string,
    flagKey: string,
    definition: FlagDefinition<unknown>,
    context: EvaluationContext,
  ): void {
    if (inFlight.has(identity)) {
      return;
    }
    let work: ProviderWork;
    try {
      work = providerWork(identity, flagKey, definition, context);
    } catch (error) {
      logger.log("warn", "flags.refresh_failed", {
        flagKey,
        error: loggableError(error),
      });
      return;
    }
    void (async () => {
      try {
        const resolution = await waitForProvider(work, timeoutMs);
        const value = decodeFlagValue(definition, resolution.value, flagKey);
        writeCache(identity, flagKey, value, resolution, nowMs(clock));
      } catch (error) {
        logger.log("warn", "flags.refresh_failed", {
          flagKey,
          error: loggableError(error),
        });
      }
    })();
  }

  async function resolveFromProvider<T>(
    identity: string | undefined,
    flagKey: string,
    definition: FlagDefinition<T>,
    context: EvaluationContext,
  ): Promise<EvaluationDetail<T>> {
    try {
      const work = providerWork(identity, flagKey, definition, context);
      const resolution = await waitForProvider(work, timeoutMs);
      const value = decodeFlagValue(definition, resolution.value, flagKey);
      writeCache(identity, flagKey, value, resolution, nowMs(clock));
      if (resolution.reason !== "TARGETING_MATCH") {
        logFallback(logger, resolution.reason, flagKey);
      }
      return toDetail(flagKey, value, resolution.reason, {
        ...(resolution.variant === undefined
          ? {}
          : { variant: resolution.variant }),
        ...(resolution.errorCode === undefined
          ? {}
          : { errorCode: resolution.errorCode }),
        ...(resolution.errorMessage === undefined
          ? {}
          : { errorMessage: loggableError(resolution.errorMessage) }),
      });
    } catch (error) {
      const stale = readCache(identity, nowMs(clock));
      if (stale !== undefined) {
        logFallback(logger, "STALE_CACHE", flagKey, error);
        return toDetail(flagKey, stale.value as T, "STALE_CACHE", {
          ...(stale.variant === undefined ? {} : { variant: stale.variant }),
        });
      }
      logFallback(logger, "ERROR", flagKey, error);
      return toDetail(flagKey, definition.defaultValue, "ERROR", {
        errorCode:
          error instanceof EvaluationTimeoutError
            ? "TIMEOUT"
            : error instanceof ProviderCapacityError
              ? "CAPACITY"
              : "PROVIDER",
        errorMessage: loggableError(error),
      });
    }
  }

  return {
    async evaluate<K extends keyof TSchema & string>(
      flagKey: K,
      context: EvaluationContext,
    ): Promise<EvaluationDetail<FlagValueOf<TSchema[K]>>> {
      requireTargetingKey(context);
      if (!Object.hasOwn(options.schema, flagKey)) {
        throw new Error(`unknown flag ${flagKey}`);
      }
      const definition = options.schema[flagKey];
      if (definition === undefined) {
        throw new Error(`unknown flag ${flagKey}`);
      }
      const identity = cacheIdentity(flagKey, context);
      const atMs = nowMs(clock);
      const cached = readCache(identity, atMs);
      if (cached !== undefined) {
        const age = atMs - cached.storedAtMs;
        if (age < cacheTtlMs) {
          if (cached.reason !== "TARGETING_MATCH") {
            logFallback(logger, cached.reason, flagKey);
          }
          return toDetail(
            flagKey,
            cached.value as FlagValueOf<TSchema[K]>,
            cached.reason,
            {
              ...(cached.variant === undefined
                ? {}
                : { variant: cached.variant }),
            },
          );
        }
        if (identity !== undefined) {
          refresh(identity, flagKey, definition, context);
        }
        logger.log("info", "flags.stale_cache", { flagKey });
        return toDetail(
          flagKey,
          cached.value as FlagValueOf<TSchema[K]>,
          "STALE_CACHE",
          {
            ...(cached.variant === undefined
              ? {}
              : { variant: cached.variant }),
          },
        );
      }
      return resolveFromProvider(
        identity,
        flagKey,
        definition as FlagDefinition<FlagValueOf<TSchema[K]>>,
        context,
      );
    },

    async get(flagKey, context) {
      const detail = await this.evaluate(flagKey, context);
      return detail.value;
    },

    invalidate(flagKey) {
      if (flagKey === undefined) {
        cache.clear();
        return;
      }
      for (const [identity, entry] of cache) {
        if (entry.flagKey === flagKey) {
          cache.delete(identity);
        }
      }
    },

    async close() {
      for (const work of activeWorks) {
        work.controller.abort();
      }
      await options.provider.close?.();
    },
  };
}
