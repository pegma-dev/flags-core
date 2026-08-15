# `@pegma/flags-aws-appconfig`

AWS AppConfig `FlagProvider` for Pegma hosts.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

The host constructs and injects an AppConfig reader. This package never
imports the AWS SDK, never owns a client singleton, and does not evaluate
multi-variant rules or percentage splits. It translates an already-evaluated
value — or a setting this package can map without becoming a second targeting
engine — into a `FlagResolution`.

Prefer a reader that returns a value AppConfig already evaluated (the
AppConfig Agent `?flag=` response, or `GetLatestConfiguration` after the
host applied context). This package can also map:

- ordinary typed values (string as-is; boolean, number, and json via JSON)
- a feature-flag document marked `type: AWS.AppConfig.FeatureFlags`, or
  one that carries AWS `_variants` metadata
- a stored default variant that has no `rule`

A JSON object that happens to include `enabled` is a payload, not a
feature-flag document. Set `type: AWS.AppConfig.FeatureFlags` when the
reader returns AppConfig feature-flag data or a retrieved flag map. An
enabled document that still carries `_variants` with a `rule` is
rejected. Wrap AppConfig evaluation in the injected reader if the host
needs those rules.

```ts
import {
  AWS_APPCONFIG_FEATURE_FLAGS_TYPE,
  awsAppConfigFlagValue,
  createAwsAppConfigFlagProvider,
} from "@pegma/flags-aws-appconfig";
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

const provider = createAwsAppConfigFlagProvider({
  reader: {
    async getConfiguration({ key }) {
      const document = await appConfig.getLatestConfiguration();
      const value = awsAppConfigFlagValue(document, key);
      if (value === undefined) {
        return undefined;
      }
      return { key, value, type: AWS_APPCONFIG_FEATURE_FLAGS_TYPE };
    },
  },
});

const client = createFlagsClient({ schema, logger, provider });
```

Import `awsAppConfigFlagValue` when the host fetched a whole
`AWS.AppConfig.FeatureFlags` document or a retrieved flag map and needs
the stored object for one key. A missing key is `DEFAULT_FALLBACK`. A
feature flag with `enabled: false` is `DISABLED`.
