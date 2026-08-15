import type {
  EvaluationContext,
  FlagProvider,
  FlagProviderCapabilities,
  FlagResolution,
  FlagResolutionRequest,
  FlagValueKind,
  JsonValue,
} from "@pegma/flags-contracts";

/**
 * OpenFeature evaluation reasons this adapter translates.
 *
 * @see https://openfeature.dev/specification/types#evaluation-reason
 */
export const FLAGD_REASON_TARGETING_MATCH = "TARGETING_MATCH";
export const FLAGD_REASON_SPLIT = "SPLIT";
export const FLAGD_REASON_DEFAULT = "DEFAULT";
export const FLAGD_REASON_STATIC = "STATIC";
export const FLAGD_REASON_CACHED = "CACHED";
export const FLAGD_REASON_STALE = "STALE";
export const FLAGD_REASON_DISABLED = "DISABLED";
export const FLAGD_REASON_ERROR = "ERROR";

/** OpenFeature `errorCode` for a flag the provider does not define. */
export const FLAGD_ERROR_FLAG_NOT_FOUND = "FLAG_NOT_FOUND";

/** JSON-compatible OpenFeature targeting attributes. */
export type FlagdAttributeValue = JsonValue;

/**
 * Flat OpenFeature evaluation context. `targetingKey` is the primary
 * identifier. Additional attributes keep their JSON-compatible values.
 *
 * @see https://openfeature.dev/specification/types#evaluation-context
 */
export interface FlagdEvaluationContext {
  readonly targetingKey: string;
  readonly [attribute: string]: FlagdAttributeValue | undefined;
}

/**
 * Narrow detail the injected reader returns. Matches OpenFeature
 * evaluation details from a flagd-backed client.
 */
export interface FlagdEvaluationDetails {
  readonly value: unknown;
  readonly variant?: string;
  readonly reason?: string;
  readonly errorCode?: string;
  readonly flagKey?: string;
}

export interface FlagdDetailsRequest {
  readonly flagKey: string;
  readonly context: EvaluationContext;
  readonly defaultValue: unknown;
  readonly kind: FlagValueKind;
}

/**
 * Host-injected flagd / OpenFeature lookup. Typically a thin wrapper
 * around `client.get*Details` that maps a missing flag to `undefined`
 * or returns OpenFeature's `FLAG_NOT_FOUND` detail. This package never
 * imports the OpenFeature SDK or a flagd provider.
 */
export interface FlagdReader {
  getDetails(
    request: FlagdDetailsRequest,
  ): Promise<FlagdEvaluationDetails | undefined>;
  close?(): void | Promise<void>;
}

export interface FlagdFlagProviderOptions {
  readonly reader: FlagdReader;
  readonly name?: string;
  readonly keyOf?: (flagKey: string) => string;
}

function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Builds the documented OpenFeature evaluation context for `context`.
 * `targetingKey` is the primary identifier. Optional tenant, environment,
 * principal, and host attributes are copied as attributes. Hosts that
 * need a different context shape should map it themselves in the
 * injected reader.
 */
export function flagdEvaluationContext(
  context: EvaluationContext,
): FlagdEvaluationContext {
  const attributes: Record<string, FlagdAttributeValue | undefined> = {
    ...(context.attributes ?? {}),
  };
  if (typeof context.principalId === "string") {
    attributes.principalId = context.principalId;
  }
  if (context.tenant !== undefined) {
    attributes.tenant = context.tenant;
  }
  if (context.environment !== undefined) {
    attributes.environment = context.environment;
  }
  return {
    ...attributes,
    targetingKey: context.targetingKey,
  };
}

function variantOf(
  detail: FlagdEvaluationDetails,
): { readonly variant: string } | Record<string, never> {
  if (typeof detail.variant !== "string" || detail.variant === "") {
    return {};
  }
  return { variant: detail.variant };
}

function requireReasonKind(detail: FlagdEvaluationDetails): string {
  const reason = own(detail, "reason");
  if (typeof reason !== "string" || reason === "") {
    throw new Error("flagd evaluation detail is missing a reason");
  }
  return reason;
}

function requireErrorCode(detail: FlagdEvaluationDetails): string | undefined {
  const errorCode = own(detail, "errorCode");
  if (errorCode === undefined) {
    return undefined;
  }
  if (typeof errorCode !== "string") {
    throw new Error("flagd evaluation detail has a non-string errorCode");
  }
  return errorCode === "" ? undefined : errorCode;
}

function resolveDetail(
  request: FlagResolutionRequest,
  detail: FlagdEvaluationDetails,
): FlagResolution {
  const reason = requireReasonKind(detail);
  const errorCode = requireErrorCode(detail);
  if (errorCode === FLAGD_ERROR_FLAG_NOT_FOUND) {
    return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
  }
  if (reason === FLAGD_REASON_ERROR || errorCode !== undefined) {
    throw new Error(
      errorCode === undefined
        ? `flagd evaluation failed for ${request.flagKey}`
        : `flagd evaluation failed for ${request.flagKey}: ${errorCode}`,
    );
  }
  switch (reason) {
    case FLAGD_REASON_TARGETING_MATCH:
    case FLAGD_REASON_SPLIT:
    case FLAGD_REASON_DEFAULT:
    case FLAGD_REASON_STATIC:
    case FLAGD_REASON_CACHED:
      return {
        value: detail.value,
        reason: "TARGETING_MATCH",
        ...variantOf(detail),
      };
    case FLAGD_REASON_STALE:
      return {
        value: detail.value,
        reason: "STALE_CACHE",
        ...variantOf(detail),
      };
    case FLAGD_REASON_DISABLED:
      return {
        value: detail.value,
        reason: "DISABLED",
        ...variantOf(detail),
      };
    default:
      throw new Error(
        `flagd evaluation reason ${reason} is not translated by this adapter`,
      );
  }
}

/**
 * Translates OpenFeature evaluation details into {@link FlagProvider}
 * resolutions. Targeting rules and percentage rollouts are not evaluated
 * here — flagd already did that. The injected reader must return an
 * already-evaluated detail.
 */
export function createFlagdFlagProvider(
  options: FlagdFlagProviderOptions,
): FlagProvider {
  if (
    options.reader === undefined ||
    typeof options.reader.getDetails !== "function"
  ) {
    throw new Error(
      "createFlagdFlagProvider requires an injected flagd reader",
    );
  }
  const name = options.name ?? "flagd";
  const capabilities: FlagProviderCapabilities = {
    static: false,
    streaming: false,
    targeting: true,
  };

  return {
    name,
    capabilities() {
      return capabilities;
    },
    async resolve(request) {
      const flagKey = options.keyOf?.(request.flagKey) ?? request.flagKey;
      const detail = await options.reader.getDetails({
        flagKey,
        context: request.context,
        defaultValue: request.defaultValue,
        kind: request.kind,
      });
      if (detail === undefined) {
        return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
      }
      return resolveDetail(request, detail);
    },
    async close() {
      await options.reader.close?.();
    },
  };
}
