import type {
  EvaluationContext,
  FlagProvider,
  FlagProviderCapabilities,
  FlagResolution,
  FlagResolutionRequest,
  FlagValueKind,
} from "@pegma/flags-contracts";

/**
 * Flagship evaluation reasons this adapter translates.
 *
 * @see https://developers.cloudflare.com/flagship/reference/evaluation-reasons/
 */
export const FLAGSHIP_REASON_TARGETING_MATCH = "TARGETING_MATCH";
export const FLAGSHIP_REASON_SPLIT = "SPLIT";
export const FLAGSHIP_REASON_DEFAULT = "DEFAULT";
export const FLAGSHIP_REASON_DISABLED = "DISABLED";
export const FLAGSHIP_REASON_CACHED = "CACHED";
export const FLAGSHIP_REASON_ERROR = "ERROR";

/** Flagship `errorCode` for a flag the app does not define. */
export const FLAGSHIP_ERROR_FLAG_NOT_FOUND = "FLAG_NOT_FOUND";

/** Scalar Flagship targeting attributes. Objects and arrays are omitted. */
export type FlagshipAttributeValue = string | number | boolean;

/**
 * Flat Flagship / OpenFeature evaluation context. `targetingKey` is the
 * primary identifier. Additional attributes must be scalars.
 *
 * @see https://developers.cloudflare.com/flagship/binding/types/
 */
export interface FlagshipEvaluationContext {
  readonly targetingKey: string;
  readonly [attribute: string]: FlagshipAttributeValue | undefined;
}

/**
 * Narrow detail the injected reader returns. Matches Flagship
 * `*Details` methods and OpenFeature evaluation details.
 */
export interface FlagshipEvaluationDetails {
  readonly value: unknown;
  readonly variant?: string;
  readonly reason?: string;
  readonly errorCode?: string;
  readonly flagKey?: string;
}

export interface FlagshipDetailsRequest {
  readonly flagKey: string;
  readonly context: EvaluationContext;
  readonly defaultValue: unknown;
  readonly kind: FlagValueKind;
}

/**
 * Host-injected Flagship lookup. Typically a thin wrapper around a
 * Workers `env.FLAGS.get*Details` binding or an OpenFeature client that
 * maps a missing flag to `undefined` or returns Flagship's
 * `FLAG_NOT_FOUND` detail. This package never imports the Flagship SDK.
 */
export interface FlagshipReader {
  getDetails(
    request: FlagshipDetailsRequest,
  ): Promise<FlagshipEvaluationDetails | undefined>;
  close?(): void | Promise<void>;
}

export interface CloudflareFlagshipFlagProviderOptions {
  readonly reader: FlagshipReader;
  readonly name?: string;
  readonly keyOf?: (flagKey: string) => string;
}

function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function isFlagshipAttributeValue(
  value: unknown,
): value is FlagshipAttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Builds the documented flat Flagship evaluation context for `context`.
 * `targetingKey` is the primary identifier. Optional tenant, environment,
 * principal, and scalar host attributes are copied as attributes. Hosts
 * that need `userId` or non-scalar attributes should map the context
 * themselves in the injected reader.
 */
export function flagshipEvaluationContext(
  context: EvaluationContext,
): FlagshipEvaluationContext {
  const attributes: Record<string, FlagshipAttributeValue | undefined> = {};
  for (const [key, value] of Object.entries(context.attributes ?? {})) {
    if (isFlagshipAttributeValue(value)) {
      attributes[key] = value;
    }
  }
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
  detail: FlagshipEvaluationDetails,
): { readonly variant: string } | Record<string, never> {
  if (typeof detail.variant !== "string" || detail.variant === "") {
    return {};
  }
  return { variant: detail.variant };
}

function requireReasonKind(detail: FlagshipEvaluationDetails): string {
  const reason = own(detail, "reason");
  if (typeof reason !== "string" || reason === "") {
    throw new Error("Flagship evaluation detail is missing a reason");
  }
  return reason;
}

function requireErrorCode(
  detail: FlagshipEvaluationDetails,
): string | undefined {
  const errorCode = own(detail, "errorCode");
  if (errorCode === undefined) {
    return undefined;
  }
  if (typeof errorCode !== "string") {
    throw new Error("Flagship evaluation detail has a non-string errorCode");
  }
  return errorCode === "" ? undefined : errorCode;
}

function resolveDetail(
  request: FlagResolutionRequest,
  detail: FlagshipEvaluationDetails,
): FlagResolution {
  const reason = requireReasonKind(detail);
  const errorCode = requireErrorCode(detail);
  if (errorCode === FLAGSHIP_ERROR_FLAG_NOT_FOUND) {
    return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
  }
  if (reason === FLAGSHIP_REASON_ERROR || errorCode !== undefined) {
    throw new Error(
      errorCode === undefined
        ? `Flagship evaluation failed for ${request.flagKey}`
        : `Flagship evaluation failed for ${request.flagKey}: ${errorCode}`,
    );
  }
  switch (reason) {
    case FLAGSHIP_REASON_TARGETING_MATCH:
    case FLAGSHIP_REASON_SPLIT:
    case FLAGSHIP_REASON_DEFAULT:
    case FLAGSHIP_REASON_CACHED:
      return {
        value: detail.value,
        reason: "TARGETING_MATCH",
        ...variantOf(detail),
      };
    case FLAGSHIP_REASON_DISABLED:
      return {
        value: detail.value,
        reason: "DISABLED",
        ...variantOf(detail),
      };
    default:
      throw new Error(
        `Flagship evaluation reason ${reason} is not translated by this adapter`,
      );
  }
}

/**
 * Translates Flagship `*Details` results into {@link FlagProvider}
 * resolutions. Targeting rules and percentage rollouts are not evaluated
 * here — Flagship already did that. The injected reader must return an
 * already-evaluated detail.
 */
export function createCloudflareFlagshipFlagProvider(
  options: CloudflareFlagshipFlagProviderOptions,
): FlagProvider {
  if (
    options.reader === undefined ||
    typeof options.reader.getDetails !== "function"
  ) {
    throw new Error(
      "createCloudflareFlagshipFlagProvider requires an injected Flagship reader",
    );
  }
  const name = options.name ?? "cloudflare-flagship";
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
