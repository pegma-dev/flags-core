import type {
  EvaluationContext,
  EvaluationDetail,
  EvaluationReason,
  FlagProvider,
  FlagResolution,
} from "@pegma/flags-contracts";
import { noopLogger, systemClock, type Clock, type Logger } from "@pegma/spine";

import {
  isJsonValue,
  type FlagDefinition,
  type FlagValueOf,
} from "./schema.js";

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_STALE_WHILE_REVALIDATE_MS = 30_000;
const MAX_LOGGED_ERROR_CHARS = 300;
const CACHE_KEY_SEPARATOR = "\u001f";

class EvaluationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`flag evaluation timed out after ${timeoutMs}ms`);
    this.name = "EvaluationTimeoutError";
  }
}

interface CacheEntry {
  readonly flagKey: string;
  readonly value: unknown;
  readonly reason: EvaluationReason;
  readonly variant?: string;
  readonly storedAtMs: number;
}

export interface FlagsClientOptions<
  TSchema extends Record<string, FlagDefinition<unknown>>,
> {
  readonly schema: TSchema;
  readonly provider: FlagProvider;
  readonly logger?: Logger;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly staleWhileRevalidateMs?: number;
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

function cacheIdentity(flagKey: string, context: EvaluationContext): string {
  return [
    flagKey,
    context.targetingKey,
    context.tenant ?? "",
    context.environment ?? "",
  ].join(CACHE_KEY_SEPARATOR);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new EvaluationTimeoutError(timeoutMs));
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
 * Error text is provider-supplied and may carry remote input, so control
 * characters (which forge log lines in text-oriented sinks) are flattened
 * and the string is capped before it reaches a logger.
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
  context: EvaluationContext,
  error?: unknown,
): void {
  logger.log(reason === "ERROR" ? "warn" : "info", "flags.fallback", {
    flagKey,
    reason,
    targetingKey: context.targetingKey,
    ...(error === undefined ? {} : { error: loggableError(error) }),
  });
}

/**
 * Constructs an injected evaluation client. The host owns the instance;
 * nothing here is stored globally.
 */
export function createFlagsClient<
  TSchema extends Record<string, FlagDefinition<unknown>>,
>(options: FlagsClientOptions<TSchema>): FlagsClient<TSchema> {
  const logger = options.logger ?? noopLogger;
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const staleWhileRevalidateMs =
    options.staleWhileRevalidateMs ?? DEFAULT_STALE_WHILE_REVALIDATE_MS;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<void>>();

  function readCache(identity: string, atMs: number): CacheEntry | undefined {
    if (cacheTtlMs <= 0) {
      return undefined;
    }
    const entry = cache.get(identity);
    if (entry === undefined) {
      return undefined;
    }
    const age = atMs - entry.storedAtMs;
    if (age < cacheTtlMs) {
      return entry;
    }
    if (age < cacheTtlMs + staleWhileRevalidateMs) {
      return entry;
    }
    return undefined;
  }

  function writeCache(
    identity: string,
    flagKey: string,
    value: unknown,
    resolution: FlagResolution,
    atMs: number,
  ): void {
    if (cacheTtlMs <= 0) {
      return;
    }
    cache.set(identity, {
      flagKey,
      value,
      reason: resolution.reason,
      ...(resolution.variant === undefined
        ? {}
        : { variant: resolution.variant }),
      storedAtMs: atMs,
    });
  }

  function refresh(
    identity: string,
    flagKey: string,
    definition: FlagDefinition<unknown>,
    context: EvaluationContext,
  ): Promise<void> {
    const existing = inFlight.get(identity);
    if (existing !== undefined) {
      return existing;
    }
    const pending = (async () => {
      try {
        const resolution = await withTimeout(
          options.provider.resolve({
            flagKey,
            defaultValue: definition.defaultValue,
            kind: definition.kind,
            context,
          }),
          timeoutMs,
        );
        const value = decodeFlagValue(definition, resolution.value, flagKey);
        writeCache(identity, flagKey, value, resolution, nowMs(clock));
      } catch (error) {
        logger.log("warn", "flags.refresh_failed", {
          flagKey,
          targetingKey: context.targetingKey,
          error: loggableError(error),
        });
      } finally {
        inFlight.delete(identity);
      }
    })();
    inFlight.set(identity, pending);
    return pending;
  }

  async function resolveFromProvider<T>(
    identity: string,
    flagKey: string,
    definition: FlagDefinition<T>,
    context: EvaluationContext,
  ): Promise<EvaluationDetail<T>> {
    try {
      const resolution = await withTimeout(
        options.provider.resolve({
          flagKey,
          defaultValue: definition.defaultValue,
          kind: definition.kind,
          context,
        }),
        timeoutMs,
      );
      const value = decodeFlagValue(definition, resolution.value, flagKey);
      writeCache(identity, flagKey, value, resolution, nowMs(clock));
      if (resolution.reason !== "TARGETING_MATCH") {
        logFallback(logger, resolution.reason, flagKey, context);
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
          : { errorMessage: resolution.errorMessage }),
      });
    } catch (error) {
      const stale = cache.get(identity);
      if (stale !== undefined) {
        logFallback(logger, "STALE_CACHE", flagKey, context, error);
        return toDetail(flagKey, stale.value as T, "STALE_CACHE", {
          ...(stale.variant === undefined ? {} : { variant: stale.variant }),
        });
      }
      logFallback(logger, "ERROR", flagKey, context, error);
      return toDetail(flagKey, definition.defaultValue, "ERROR", {
        errorCode:
          error instanceof EvaluationTimeoutError ? "TIMEOUT" : "PROVIDER",
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
        void refresh(identity, flagKey, definition, context);
        logger.log("info", "flags.stale_cache", {
          flagKey,
          targetingKey: context.targetingKey,
        });
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
      const prefix = `${flagKey}${CACHE_KEY_SEPARATOR}`;
      for (const identity of cache.keys()) {
        if (identity.startsWith(prefix)) {
          cache.delete(identity);
        }
      }
    },

    async close() {
      await options.provider.close?.();
    },
  };
}
