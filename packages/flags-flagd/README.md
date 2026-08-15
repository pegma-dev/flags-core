# `@pegma/flags-flagd`

flagd / OpenFeature `FlagProvider` for Pegma hosts.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

The host constructs and injects a flagd / OpenFeature reader. This package
never imports the OpenFeature SDK or a flagd provider, never owns a client
singleton, and does not evaluate targeting rules or percentage rollouts. It
translates an already-evaluated OpenFeature detail into a `FlagResolution`.

```ts
import {
  createFlagdFlagProvider,
  flagdEvaluationContext,
} from "@pegma/flags-flagd";
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

const provider = createFlagdFlagProvider({
  reader: {
    async getDetails({ flagKey, context, defaultValue, kind }) {
      const evaluationContext = flagdEvaluationContext(context);
      switch (kind) {
        case "boolean":
          return client.getBooleanDetails(
            flagKey,
            defaultValue,
            evaluationContext,
          );
        case "string":
          return client.getStringDetails(
            flagKey,
            defaultValue,
            evaluationContext,
          );
        case "number":
          return client.getNumberDetails(
            flagKey,
            defaultValue,
            evaluationContext,
          );
        case "json":
          return client.getObjectDetails(
            flagKey,
            defaultValue,
            evaluationContext,
          );
      }
    },
    close() {
      return client.close?.();
    },
  },
});

const flags = createFlagsClient({ schema, logger, provider });
```

`client` is the host's OpenFeature client configured with a flagd
provider. Import `flagdEvaluationContext` when the host wants the
documented OpenFeature context (`targetingKey` plus attributes). Hosts
that need a different context shape can map `EvaluationContext`
themselves inside the reader.

A missing flag (`undefined` from the reader, or OpenFeature
`FLAG_NOT_FOUND`) is `DEFAULT_FALLBACK`. `DISABLED` is `DISABLED`.
`STALE` is `STALE_CACHE` so the flags client records the stale reason
and emits fallback telemetry. `TARGETING_MATCH`, `SPLIT`, `DEFAULT`,
`STATIC`, and `CACHED` are `TARGETING_MATCH` — flagd already evaluated
those rules. Other OpenFeature `ERROR` codes propagate so the flags
client can record `ERROR`.
