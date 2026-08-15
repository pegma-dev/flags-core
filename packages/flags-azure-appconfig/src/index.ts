import type {
  EvaluationContext,
  FlagProvider,
  FlagProviderCapabilities,
  FlagResolution,
  FlagResolutionRequest,
  FlagValueKind,
} from "@pegma/flags-contracts";

/**
 * Microsoft's documented feature-flag content type, including charset.
 *
 * @see https://learn.microsoft.com/azure/azure-app-configuration/manage-feature-flags
 */
export const AZURE_FEATURE_FLAG_CONTENT_TYPE =
  "application/vnd.microsoft.appconfig.ff+json;charset=utf-8";

const AZURE_FEATURE_FLAG_MEDIA_TYPE =
  "application/vnd.microsoft.appconfig.ff+json";

/**
 * Microsoft's documented feature-flag key prefix.
 *
 * @see https://learn.microsoft.com/azure/azure-app-configuration/manage-feature-flags
 */
export const AZURE_FEATURE_FLAG_KEY_PREFIX = ".appconfig.featureflag/";

/** Narrow setting the injected reader returns. Matches App Configuration. */
export interface AzureAppConfigurationSetting {
  readonly key: string;
  readonly value?: string;
  readonly contentType?: string;
  readonly label?: string;
}

export interface AzureAppConfigurationGetRequest {
  readonly key: string;
  readonly context: EvaluationContext;
  readonly label?: string;
}

/**
 * Host-injected App Configuration lookup. Typically a thin wrapper around
 * `AppConfigurationClient.getConfigurationSetting` that maps HTTP 404 to
 * `undefined`. This package never imports the Azure SDK.
 */
export interface AzureAppConfigurationReader {
  getConfigurationSetting(
    request: AzureAppConfigurationGetRequest,
  ): Promise<AzureAppConfigurationSetting | undefined>;
  close?(): void | Promise<void>;
}

export interface AzureAppConfigFlagProviderOptions {
  readonly reader: AzureAppConfigurationReader;
  readonly name?: string;
  readonly keyOf?: (flagKey: string) => string;
  readonly labelOf?: (context: EvaluationContext) => string | undefined;
}

/**
 * Builds the documented App Configuration feature-flag key for `flagKey`.
 * Hosts that store ordinary key-values should not use this.
 */
export function azureFeatureFlagKey(flagKey: string): string {
  return `${AZURE_FEATURE_FLAG_KEY_PREFIX}${flagKey}`;
}

function own(record: object, key: string): unknown {
  return Object.hasOwn(record, key)
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function isFeatureFlagContentType(contentType: string | undefined): boolean {
  if (contentType === undefined || contentType === "") {
    return false;
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === AZURE_FEATURE_FLAG_MEDIA_TYPE;
}

function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Azure App Configuration ${what} is not valid JSON`);
  }
}

function parseTypedValue(kind: FlagValueKind, raw: string): unknown {
  if (kind === "string") {
    return raw;
  }
  return parseJson(raw, `${kind} value`);
}

function variantByName(
  variants: unknown,
  name: string,
): { readonly value: unknown; readonly variant: string } | undefined {
  if (!Array.isArray(variants)) {
    return undefined;
  }
  for (const entry of variants) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const variantName = own(entry, "name");
    if (variantName === name) {
      return { value: own(entry, "configuration_value"), variant: name };
    }
  }
  return undefined;
}

function allocatedVariant(
  document: object,
  allocationKey: "default_when_enabled" | "default_when_disabled",
): { readonly value: unknown; readonly variant: string } | undefined {
  const allocation = own(document, "allocation");
  if (
    allocation === null ||
    typeof allocation !== "object" ||
    Array.isArray(allocation)
  ) {
    return undefined;
  }
  const name = own(allocation, allocationKey);
  if (typeof name !== "string" || name === "") {
    return undefined;
  }
  return variantByName(own(document, "variants"), name);
}

function hasRules(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  return !Array.isArray(value) || value.length > 0;
}

/**
 * True when the document still carries targeting or rollout rules this
 * adapter does not evaluate. Empty `client_filters` is Azure's usual
 * unconditional shape and is not a rule.
 */
function hasUnevaluatedTargeting(document: object): boolean {
  const conditions = own(document, "conditions");
  if (
    conditions !== null &&
    typeof conditions === "object" &&
    !Array.isArray(conditions) &&
    hasRules(own(conditions, "client_filters"))
  ) {
    return true;
  }
  const allocation = own(document, "allocation");
  if (
    allocation === null ||
    typeof allocation !== "object" ||
    Array.isArray(allocation)
  ) {
    return false;
  }
  return (
    hasRules(own(allocation, "percentile")) ||
    hasRules(own(allocation, "user")) ||
    hasRules(own(allocation, "group"))
  );
}

function refuseUnevaluatedTargeting(document: object, flagKey: string): void {
  if (hasUnevaluatedTargeting(document)) {
    throw new Error(
      `Azure feature flag ${flagKey} has targeting filters or a percentage rollout that this adapter does not evaluate`,
    );
  }
}

function resolveFeatureFlag(
  request: FlagResolutionRequest,
  raw: string,
): FlagResolution {
  const parsed = parseJson(raw, "feature flag");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Azure feature flag document must be a JSON object");
  }
  const enabled = own(parsed, "enabled");
  if (typeof enabled !== "boolean") {
    throw new Error(
      "Azure feature flag document is missing a boolean enabled field",
    );
  }

  if (!enabled) {
    const allocated = allocatedVariant(parsed, "default_when_disabled");
    if (allocated !== undefined) {
      return {
        value: allocated.value,
        reason: "DISABLED",
        variant: allocated.variant,
      };
    }
    if (request.kind !== "boolean") {
      throw new Error(
        `Azure feature flag ${request.flagKey} is disabled and has no default_when_disabled variant for a ${request.kind} flag`,
      );
    }
    return { value: false, reason: "DISABLED" };
  }

  refuseUnevaluatedTargeting(parsed, request.flagKey);

  const allocated = allocatedVariant(parsed, "default_when_enabled");
  if (allocated !== undefined) {
    return {
      value: allocated.value,
      reason: "TARGETING_MATCH",
      variant: allocated.variant,
    };
  }
  if (request.kind !== "boolean") {
    throw new Error(
      `Azure feature flag ${request.flagKey} has no default_when_enabled variant for a ${request.kind} flag`,
    );
  }
  return { value: true, reason: "TARGETING_MATCH" };
}

function resolveSetting(
  request: FlagResolutionRequest,
  setting: AzureAppConfigurationSetting,
): FlagResolution {
  if (setting.value === undefined) {
    throw new Error(
      `Azure App Configuration setting ${setting.key} has no value`,
    );
  }
  if (isFeatureFlagContentType(setting.contentType)) {
    return resolveFeatureFlag(request, setting.value);
  }
  return {
    value: parseTypedValue(request.kind, setting.value),
    reason: "TARGETING_MATCH",
  };
}

/**
 * Translates Azure App Configuration settings into {@link FlagProvider}
 * resolutions. Targeting filters and percentage rollouts are not evaluated
 * here. An enabled document that still carries those rules is rejected so
 * this adapter cannot report a targeting match it did not compute. The
 * injected reader must return an already-evaluated setting when the host
 * needs Azure Feature Management.
 */
export function createAzureAppConfigFlagProvider(
  options: AzureAppConfigFlagProviderOptions,
): FlagProvider {
  if (
    options.reader === undefined ||
    typeof options.reader.getConfigurationSetting !== "function"
  ) {
    throw new Error(
      "createAzureAppConfigFlagProvider requires an injected Azure App Configuration reader",
    );
  }
  const name = options.name ?? "azure-appconfig";
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
      const label = options.labelOf?.(request.context);
      const setting = await options.reader.getConfigurationSetting({
        key,
        context: request.context,
        ...(label === undefined ? {} : { label }),
      });
      if (setting === undefined) {
        return { value: request.defaultValue, reason: "DEFAULT_FALLBACK" };
      }
      return resolveSetting(request, setting);
    },
    async close() {
      await options.reader.close?.();
    },
  };
}
