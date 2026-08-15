import type {
  EvaluationContext,
  FlagProvider,
  FlagProviderCapabilities,
  FlagResolution,
  FlagResolutionRequest,
  JsonValue,
} from "@pegma/flags-contracts";

/**
 * LaunchDarkly evaluation reason kinds this adapter translates.
 *
 * @see https://docs.launchdarkly.com/sdk/concepts/evaluation-reasons
 */
export const LAUNCHDARKLY_REASON_OFF = "OFF";
export const LAUNCHDARKLY_REASON_FALLTHROUGH = "FALLTHROUGH";
export const LAUNCHDARKLY_REASON_TARGET_MATCH = "TARGET_MATCH";
export const LAUNCHDARKLY_REASON_RULE_MATCH = "RULE_MATCH";
export const LAUNCHDARKLY_REASON_PREREQUISITE_FAILED = "PREREQUISITE_FAILED";
export const LAUNCHDARKLY_REASON_ERROR = "ERROR";

/** LaunchDarkly `errorKind` for a flag the project does not define. */
export const LAUNCHDARKLY_ERROR_FLAG_NOT_FOUND = "FLAG_NOT_FOUND";

/** Narrow reason the injected reader returns. Matches LaunchDarkly. */
export interface LaunchDarklyEvaluationReason {
  readonly kind: string;
  readonly errorKind?: string;
}

/** Narrow detail the injected reader returns. Matches LaunchDarkly. */
export interface LaunchDarklyEvaluationDetail {
  readonly value: unknown;
  readonly variationIndex?: number;
  readonly reason: LaunchDarklyEvaluationReason;
}

export interface LaunchDarklyVariationRequest {
  readonly flagKey: string;
  readonly context: EvaluationContext;
  readonly defaultValue: unknown;
}

/**
 * Host-injected LaunchDarkly lookup. Typically a thin wrapper around
 * `LDClient.variationDetail` that maps a missing flag to `undefined` or
 * returns LaunchDarkly's `FLAG_NOT_FOUND` detail. This package never
 * imports the LaunchDarkly SDK.
 */
export interface LaunchDarklyReader {
  variationDetail(
    request: LaunchDarklyVariationRequest,
  ): Promise<LaunchDarklyEvaluationDetail | undefined>;
  close?(): void | Promise<void>;
}

export interface LaunchDarklyFlagProviderOptions {
  readonly reader: LaunchDarklyReader;
  readonly name?: string;
  readonly keyOf?: (flagKey: string) => string;
}

/**
 * Single-kind LaunchDarkly user context built from Pegma evaluation
 * context. `key` is the targeting key. Optional tenant, environment,
 * principal, and host attributes are copied as custom attributes.
 */
export interface LaunchDarklyUserContext {
  readonly kind: "user";
  readonly key: string;
  readonly [attribute: string]: JsonValue | undefined;
}

function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Builds the documented single-kind LaunchDarkly user context for
 * `context`. Hosts that need a multi-kind context should map it
 * themselves in the injected reader.
 */
export function launchDarklyUserContext(
  context: EvaluationContext,
): LaunchDarklyUserContext {
  const attributes: Record<string, JsonValue | undefined> = {
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
    kind: "user",
    key: context.targetingKey,
  };
}

function variantOf(
  detail: LaunchDarklyEvaluationDetail,
): { readonly variant: string } | Record<string, never> {
  if (
    detail.variationIndex === undefined ||
    !Number.isInteger(detail.variationIndex)
  ) {
    return {};
  }
  return { variant: String(detail.variationIndex) };
}

function requireReason(
  detail: LaunchDarklyEvaluationDetail,
): LaunchDarklyEvaluationReason {
  const reason = detail.reason;
  if (reason === null || typeof reason !== "object" || Array.isArray(reason)) {
    throw new Error("LaunchDarkly evaluation detail is missing a reason");
  }
  const kind = own(reason, "kind");
  if (typeof kind !== "string" || kind === "") {
    throw new Error("LaunchDarkly evaluation detail is missing a reason kind");
  }
  const errorKind = own(reason, "errorKind");
  if (errorKind !== undefined && typeof errorKind !== "string") {
    throw new Error(
      "LaunchDarkly evaluation detail has a non-string errorKind",
    );
  }
  return {
    kind,
    ...(errorKind === undefined ? {} : { errorKind }),
  };
}

function resolveDetail(
  request: FlagResolutionRequest,
  detail: LaunchDarklyEvaluationDetail,
): FlagResolution {
  const reason = requireReason(detail);
  switch (reason.kind) {
    case LAUNCHDARKLY_REASON_TARGET_MATCH:
    case LAUNCHDARKLY_REASON_RULE_MATCH:
    case LAUNCHDARKLY_REASON_FALLTHROUGH:
      return {
        value: detail.value,
        reason: "TARGETING_MATCH",
        ...variantOf(detail),
      };
    case LAUNCHDARKLY_REASON_OFF:
    case LAUNCHDARKLY_REASON_PREREQUISITE_FAILED:
      return {
        value: detail.value,
        reason: "DISABLED",
        ...variantOf(detail),
      };
    case LAUNCHDARKLY_REASON_ERROR:
      if (reason.errorKind === LAUNCHDARKLY_ERROR_FLAG_NOT_FOUND) {
        return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
      }
      throw new Error(
        reason.errorKind === undefined
          ? `LaunchDarkly evaluation failed for ${request.flagKey}`
          : `LaunchDarkly evaluation failed for ${request.flagKey}: ${reason.errorKind}`,
      );
    default:
      throw new Error(
        `LaunchDarkly evaluation reason ${reason.kind} is not translated by this adapter`,
      );
  }
}

/**
 * Translates LaunchDarkly `variationDetail` results into
 * {@link FlagProvider} resolutions. Targeting rules and percentage
 * rollouts are not evaluated here — LaunchDarkly already did that. The
 * injected reader must return an already-evaluated detail.
 */
export function createLaunchDarklyFlagProvider(
  options: LaunchDarklyFlagProviderOptions,
): FlagProvider {
  if (
    options.reader === undefined ||
    typeof options.reader.variationDetail !== "function"
  ) {
    throw new Error(
      "createLaunchDarklyFlagProvider requires an injected LaunchDarkly reader",
    );
  }
  const name = options.name ?? "launchdarkly";
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
      const detail = await options.reader.variationDetail({
        flagKey,
        context: request.context,
        defaultValue: request.defaultValue,
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
