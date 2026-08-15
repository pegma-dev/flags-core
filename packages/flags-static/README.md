# `@pegma/flags-static`

In-memory / static `FlagProvider` for Pegma tests and local development.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import { createStaticFlagProvider, staticFlag } from "@pegma/flags-static";

const provider = createStaticFlagProvider({
  flags: {
    checkoutEnabled: true,
    theme: "dark",
    legacyCheckout: staticFlag({ value: false, disabled: true }),
  },
});
```

Use `staticFlag(...)` when a flag is disabled or carries a variant. A
plain object with `value` / `disabled` keys is a JSON payload, not a
wrapper.

This package depends only on `@pegma/flags-contracts`. It does not talk to a
vendor SDK and does not evaluate a rule language — it returns the map you
gave it, optionally filtered by targeting key.
