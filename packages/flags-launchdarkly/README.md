# `@pegma/flags-launchdarkly`

LaunchDarkly `FlagProvider` for Pegma hosts.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

The host constructs and injects a LaunchDarkly reader. This package never
imports the LaunchDarkly SDK, never owns a client singleton, and does not
evaluate targeting rules or percentage rollouts. It translates an already
evaluated `variationDetail` result into a `FlagResolution`.

```ts
import {
  createLaunchDarklyFlagProvider,
  launchDarklyUserContext,
} from "@pegma/flags-launchdarkly";
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

const provider = createLaunchDarklyFlagProvider({
  reader: {
    async variationDetail({ flagKey, context, defaultValue }) {
      return ldClient.variationDetail(
        flagKey,
        launchDarklyUserContext(context),
        defaultValue,
      );
    },
    close() {
      return ldClient.close();
    },
  },
});

const client = createFlagsClient({ schema, logger, provider });
```

Import `launchDarklyUserContext` from this package when the host wants the
documented single-kind user context (`kind: "user"`, `key` = targeting
key). Hosts that need a multi-kind context can map `EvaluationContext`
themselves inside the reader.

A missing flag (`undefined` from the reader, or LaunchDarkly
`FLAG_NOT_FOUND`) is `DEFAULT_FALLBACK`. `OFF` and
`PREREQUISITE_FAILED` are `DISABLED`. `TARGET_MATCH`, `RULE_MATCH`, and
`FALLTHROUGH` are `TARGETING_MATCH` — LaunchDarkly already evaluated
those rules. Other LaunchDarkly `ERROR` kinds propagate so the flags
client can record `ERROR`.
