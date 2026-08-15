# `@pegma/flags-azure-appconfig`

Azure App Configuration `FlagProvider` for Pegma hosts.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

The host constructs and injects an App Configuration reader. This package
never imports the Azure SDK, never owns a client singleton, and does not
evaluate targeting filters or percentage rollouts. It translates a setting
into a `FlagResolution`.

Microsoft documents two setting shapes this adapter understands:

- ordinary key-values, looked up by the flag key (or a host `keyOf`)
- feature flags, identified by content type
  `application/vnd.microsoft.appconfig.ff+json;charset=utf-8`

Feature-flag keys in App Configuration use the documented prefix
`.appconfig.featureflag/`. Pass `keyOf: azureFeatureFlagKey` when the host
stores flags that way. This package does not invent a second layout.

```ts
import { createAzureAppConfigFlagProvider } from "@pegma/flags-azure-appconfig";
import { createFlagsClient, declareFlags, flag } from "@pegma/flags-core";
import type { Logger } from "@pegma/spine";

const schema = declareFlags({
  checkoutEnabled: flag.boolean({ defaultValue: false }),
});

const logger: Logger = {
  log(level, message, fields) {
    console.log(level, message, fields);
  },
};

const provider = createAzureAppConfigFlagProvider({
  reader: {
    async getConfigurationSetting({ key, label }) {
      try {
        return await appConfig.getConfigurationSetting({ key, label });
      } catch (error) {
        if (isNotFound(error)) {
          return undefined;
        }
        throw error;
      }
    },
  },
});

const client = createFlagsClient({ schema, logger, provider });
```

A missing key is `DEFAULT_FALLBACK`. A feature flag with `enabled: false`
is `DISABLED`. An enabled document that still carries targeting filters
or a percentage rollout is rejected — this adapter does not evaluate
those rules and will not report `TARGETING_MATCH` for them. Wrap Azure
Feature Management in the injected reader and return an already-evaluated
setting if the host needs that evaluation.
