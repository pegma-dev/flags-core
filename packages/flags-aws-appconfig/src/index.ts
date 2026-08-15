import type {
  EvaluationContext,
  FlagProvider,
  FlagProviderCapabilities,
  FlagResolution,
  FlagResolutionRequest,
  FlagValueKind,
} from "@pegma/flags-contracts";

/**
 * AWS AppConfig hosted feature-flag configuration type.
 *
 * @see https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-type-reference-feature-flags.html
 */
export const AWS_APPCONFIG_FEATURE_FLAGS_TYPE = "AWS.AppConfig.FeatureFlags";

/** Narrow configuration the injected reader returns. Matches AppConfig. */
export interface AwsAppConfigConfiguration {
  readonly key: string;
  readonly value?: unknown;
  readonly contentType?: string;
  readonly type?: string;
}

export interface AwsAppConfigGetRequest {
  readonly key: string;
  readonly context: EvaluationContext;
}

/**
 * Host-injected AppConfig lookup. Typically a thin wrapper around the
 * AppConfig Agent `?flag=` response or `GetLatestConfiguration` that maps
 * a missing flag to `undefined`. This package never imports the AWS SDK.
 */
export interface AwsAppConfigReader {
  getConfiguration(
    request: AwsAppConfigGetRequest,
  ): Promise<AwsAppConfigConfiguration | undefined>;
  close?(): void | Promise<void>;
}

export interface AwsAppConfigFlagProviderOptions {
  readonly reader: AwsAppConfigReader;
  readonly name?: string;
  readonly keyOf?: (flagKey: string) => string;
}

function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function isPlainObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`AWS AppConfig ${what} is not valid JSON`);
  }
}

function isFeatureFlagsType(configuration: AwsAppConfigConfiguration): boolean {
  return configuration.type === AWS_APPCONFIG_FEATURE_FLAGS_TYPE;
}

function hasVariants(value: unknown): boolean {
  return isPlainObject(value) && Array.isArray(own(value, "_variants"));
}

function isSingleFeatureFlagEntry(value: unknown): value is object {
  return (
    isPlainObject(value) &&
    (Object.hasOwn(value, "enabled") || hasVariants(value))
  );
}

/**
 * Feature-flag documents need AWS metadata. A boolean `enabled` field
 * alone is a valid JSON payload and is not enough.
 */
function isFeatureFlagDocument(
  configuration: AwsAppConfigConfiguration,
  value: unknown,
): boolean {
  return isFeatureFlagsType(configuration) || hasVariants(value);
}

function isFlagSetDocument(value: unknown): value is object {
  return (
    isPlainObject(value) &&
    typeof own(value, "version") === "string" &&
    isPlainObject(own(value, "values"))
  );
}

/**
 * Reads the stored flag object from an `AWS.AppConfig.FeatureFlags`
 * document or a retrieved flag map. Does not evaluate variants.
 */
export function awsAppConfigFlagValue(
  document: unknown,
  flagKey: string,
): unknown {
  if (!isPlainObject(document)) {
    return undefined;
  }
  const values = own(document, "values");
  if (isPlainObject(values) && Object.hasOwn(values, flagKey)) {
    return own(values, flagKey);
  }
  if (Object.hasOwn(document, flagKey)) {
    return own(document, flagKey);
  }
  return undefined;
}

function variantRule(entry: object): string | undefined {
  const rule = own(entry, "rule");
  if (rule === undefined) {
    return undefined;
  }
  if (typeof rule !== "string") {
    throw new Error("AWS AppConfig feature flag variant rule must be a string");
  }
  return rule === "" ? undefined : rule;
}

function hasUnevaluatedTargeting(document: object): boolean {
  const variants = own(document, "_variants");
  if (variants === undefined) {
    return false;
  }
  if (!Array.isArray(variants)) {
    return true;
  }
  for (const entry of variants) {
    if (!isPlainObject(entry)) {
      continue;
    }
    if (variantRule(entry) !== undefined) {
      return true;
    }
  }
  return false;
}

function refuseUnevaluatedTargeting(document: object, flagKey: string): void {
  if (hasUnevaluatedTargeting(document)) {
    throw new Error(
      `AWS AppConfig feature flag ${flagKey} has targeting rules or a percentage rollout that this adapter does not evaluate`,
    );
  }
}

function defaultVariant(
  document: object,
): { readonly enabled: boolean; readonly variant: string } | undefined {
  const variants = own(document, "_variants");
  if (!Array.isArray(variants) || variants.length === 0) {
    return undefined;
  }
  for (let index = variants.length - 1; index >= 0; index -= 1) {
    const entry = variants[index];
    if (!isPlainObject(entry)) {
      continue;
    }
    if (variantRule(entry) !== undefined) {
      continue;
    }
    const name = own(entry, "name");
    const enabled = own(entry, "enabled");
    if (typeof name !== "string" || name === "") {
      throw new Error(
        "AWS AppConfig feature flag default variant is missing a name",
      );
    }
    if (typeof enabled !== "boolean") {
      throw new Error(
        "AWS AppConfig feature flag default variant is missing a boolean enabled field",
      );
    }
    return { enabled, variant: name };
  }
  return undefined;
}

function booleanFromFeatureFlag(
  request: FlagResolutionRequest,
  enabled: boolean,
  reason: "TARGETING_MATCH" | "DISABLED",
  variant?: string,
): FlagResolution {
  if (request.kind !== "boolean") {
    throw new Error(
      `AWS AppConfig feature flag ${request.flagKey} has no stored ${request.kind} value`,
    );
  }
  return {
    value: enabled,
    reason,
    ...(variant === undefined ? {} : { variant }),
  };
}

function resolveFeatureFlag(
  request: FlagResolutionRequest,
  document: object,
): FlagResolution {
  const enabled = own(document, "enabled");
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error(
      "AWS AppConfig feature flag document is missing a boolean enabled field",
    );
  }

  if (enabled === false) {
    const stored = defaultVariant(document);
    if (stored !== undefined) {
      return booleanFromFeatureFlag(
        request,
        stored.enabled,
        "DISABLED",
        stored.variant,
      );
    }
    return booleanFromFeatureFlag(request, false, "DISABLED");
  }

  refuseUnevaluatedTargeting(document, request.flagKey);

  const stored = defaultVariant(document);
  if (stored !== undefined) {
    return booleanFromFeatureFlag(
      request,
      stored.enabled,
      "TARGETING_MATCH",
      stored.variant,
    );
  }
  if (enabled !== true) {
    throw new Error(
      "AWS AppConfig feature flag document is missing a boolean enabled field",
    );
  }
  return booleanFromFeatureFlag(request, true, "TARGETING_MATCH");
}

function unwrapFlagEntry(
  value: unknown,
  key: string,
  configuration: AwsAppConfigConfiguration,
): unknown {
  if (isFlagSetDocument(value)) {
    if (!isFeatureFlagsType(configuration)) {
      return value;
    }
    return awsAppConfigFlagValue(value, key);
  }
  if (!isFeatureFlagsType(configuration) || !isPlainObject(value)) {
    return value;
  }
  if (isSingleFeatureFlagEntry(value)) {
    return value;
  }
  if (Object.hasOwn(value, key)) {
    return own(value, key);
  }
  return undefined;
}

function parseTypedValue(kind: FlagValueKind, raw: string): unknown {
  if (kind === "string") {
    return raw;
  }
  return parseJson(raw, `${kind} value`);
}

function resolveValue(
  request: FlagResolutionRequest,
  configuration: AwsAppConfigConfiguration,
  value: unknown,
): FlagResolution {
  if (isFeatureFlagDocument(configuration, value)) {
    if (!isPlainObject(value)) {
      throw new Error(
        "AWS AppConfig feature flag document must be a JSON object",
      );
    }
    return resolveFeatureFlag(request, value);
  }
  if (typeof value === "string") {
    return {
      value: parseTypedValue(request.kind, value),
      reason: "TARGETING_MATCH",
    };
  }
  return { value, reason: "TARGETING_MATCH" };
}

function resolveConfiguration(
  request: FlagResolutionRequest,
  configuration: AwsAppConfigConfiguration,
): FlagResolution {
  if (configuration.value === undefined) {
    throw new Error(
      `AWS AppConfig configuration ${configuration.key} has no value`,
    );
  }
  const raw = configuration.value;
  const parsed =
    typeof raw === "string" && isFeatureFlagsType(configuration)
      ? parseJson(raw, "feature flag")
      : raw;
  const unwrapped = unwrapFlagEntry(parsed, configuration.key, configuration);
  if (unwrapped === undefined) {
    return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
  }
  return resolveValue(request, configuration, unwrapped);
}

/**
 * Translates AWS AppConfig configurations into {@link FlagProvider}
 * resolutions. Multi-variant rules and percentage splits are not evaluated
 * here. An enabled document that still carries those rules is rejected so
 * this adapter cannot report a targeting match it did not compute. The
 * injected reader must return an already-evaluated value when the host
 * needs AppConfig variant evaluation.
 */
export function createAwsAppConfigFlagProvider(
  options: AwsAppConfigFlagProviderOptions,
): FlagProvider {
  if (
    options.reader === undefined ||
    typeof options.reader.getConfiguration !== "function"
  ) {
    throw new Error(
      "createAwsAppConfigFlagProvider requires an injected AWS AppConfig reader",
    );
  }
  const name = options.name ?? "aws-appconfig";
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
      const key = options.keyOf?.(request.flagKey) ?? request.flagKey;
      const configuration = await options.reader.getConfiguration({
        key,
        context: request.context,
      });
      if (configuration === undefined) {
        return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
      }
      return resolveConfiguration(request, configuration);
    },
    async close() {
      await options.reader.close?.();
    },
  };
}
