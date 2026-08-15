# `@pegma/flags-contracts`

Evaluation context, detail, reasons, and the `FlagProvider` port for Pegma
feature flags.

> [!IMPORTANT]
> Pegma is in early `0.x` development. This package's public API is unstable.

```ts
import type {
  EvaluationContext,
  EvaluationDetail,
  FlagProvider,
} from "@pegma/flags-contracts";
```

This package owns the shared types. It does not evaluate flags and does not
talk to a vendor SDK.
