# `@pegma/flags-core`

Typed flag schema, evaluation client, timeout/fallback cache, and adapter
conformance for Pegma hosts.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { declareFlags, flag, createFlagsClient } from "@pegma/flags-core";
import { createStaticFlagProvider } from "@pegma/flags-static";
import type { Logger } from "@pegma/spine";

const schema = declareFlags({
  checkoutEnabled: flag.boolean({ defaultValue: false }),
});

const logger: Logger = {
  log(level, message, fields) {
    console.log(level, message, fields);
  },
};

const client = createFlagsClient({
  schema,
  logger,
  provider: createStaticFlagProvider({
    flags: { checkoutEnabled: true },
  }),
});

const enabled = await client.get("checkoutEnabled", {
  targetingKey: "user-1",
});
```

The client never blocks a request on an unbounded provider call. A timeout
or error returns the default (or a stale cache entry) with an explicit
reason and a log line. This package does not author flags and does not
evaluate targeting rules.
