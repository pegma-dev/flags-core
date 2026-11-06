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

Provider calls receive an optional `AbortSignal`. When an evaluation context
has a bounded canonical identity, concurrent misses share one provider call
and completed values can enter the cache. Oversized or non-canonical contexts
skip both mechanisms. The evaluation cache is an LRU capped at 1,024 entries
by default. Set `maxCacheEntries` to a smaller non-negative integer when a
host needs a tighter bound; zero disables stored entries. Cache identity
covers the complete evaluation context, while client fallback logs include
the flag key and coarse reason without the raw `targetingKey`.
