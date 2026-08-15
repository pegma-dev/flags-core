# `@pegma/flags-static`

In-memory / static `FlagProvider` for Pegma tests and local development.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { createStaticFlagProvider } from "@pegma/flags-static";

const provider = createStaticFlagProvider({
  flags: {
    checkoutEnabled: true,
    theme: "dark",
  },
});
```

This package depends only on `@pegma/flags-contracts`. It does not talk to a
vendor SDK and does not evaluate a rule language — it returns the map you
gave it, optionally filtered by targeting key.
