# `@pegma/flags-cloudflare-flagship`

Cloudflare Flagship `FlagProvider` for Pegma hosts.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

The host constructs and injects a Flagship reader. This package never
imports the Flagship SDK, never owns a client singleton, and does not
evaluate targeting rules or percentage rollouts. It translates an already
evaluated `*Details` result into a `FlagResolution`.

```ts
import {
  createCloudflareFlagshipFlagProvider,
  flagshipEvaluationContext,
} from "@pegma/flags-cloudflare-flagship";
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

const provider = createCloudflareFlagshipFlagProvider({
  reader: {
    async getDetails({ flagKey, context, defaultValue, kind }) {
      const evaluationContext = flagshipEvaluationContext(context);
      switch (kind) {
        case "boolean":
          return flags.getBooleanDetails(
            flagKey,
            defaultValue,
            evaluationContext,
          );
        case "string":
          return flags.getStringDetails(
            flagKey,
            defaultValue,
            evaluationContext,
          );
        case "number":
          return flags.getNumberDetails(
            flagKey,
            defaultValue,
            evaluationContext,
          );
        case "json":
          return flags.getObjectDetails(
            flagKey,
            defaultValue,
            evaluationContext,
          );
      }
    },
  },
});

const client = createFlagsClient({ schema, logger, provider });
```

`flags` is the host's Workers binding or OpenFeature client. Import
`flagshipEvaluationContext` when the host wants the documented flat
context (`targetingKey` plus scalar attributes). Hosts that need `userId`
or non-scalar attributes can map `EvaluationContext` themselves inside
the reader.

A missing flag (`undefined` from the reader, or Flagship
`FLAG_NOT_FOUND`) is `DEFAULT_FALLBACK`. `DISABLED` is `DISABLED`.
`TARGETING_MATCH`, `SPLIT`, `DEFAULT`, and `CACHED` are
`TARGETING_MATCH` — Flagship already evaluated those rules. Other
Flagship `ERROR` codes propagate so the flags client can record `ERROR`.
