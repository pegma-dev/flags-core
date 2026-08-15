# Flags Core

[![CI](https://github.com/pegma-dev/flags-core/actions/workflows/ci.yml/badge.svg)](https://github.com/pegma-dev/flags-core/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Provider-neutral feature flag evaluation for Pegma hosts: typed schemas,
evaluation context, and adapter conformance.

> [!IMPORTANT]
> Pegma is in early `0.x` development. Packages are prepared, but no public
> API is stable. Nothing in this repository has been published to npm.

## Why it exists

Hosts need one evaluation client that every flag provider can satisfy: a
strongly typed schema, a standard context, a uniform detail record with an
honest reason, and a cache that never blocks a request on the network. This
repository owns that contract. The host owns wiring. The provider owns
targeting rules.

## Constraint that shapes everything

**Read and evaluate; never author.** No control-plane UI. No custom rule
language. No global client. No silent fallback.

## Owns

- Typed flag schema (`declareFlags` / `flag.boolean|string|number|json`)
- Standardized `EvaluationContext` and `EvaluationDetail<T>`
- Local snapshot / TTL cache with stale-while-revalidate
- A conformance suite every adapter must pass
- Ports for Spine `Logger`, `Clock`, and a health probe helper

## Refuses

- Flag authoring or a control-plane UI (`@pegma/flags-storage` is not in
  scope)
- A custom rule or expression language
- Global singletons or ambient request context
- Blocking synchronous network on the request path
- Returning a default without a log line and an evaluation reason

## Usage

```ts
import { declareFlags, flag, createFlagsClient } from "@pegma/flags-core";
import { createStaticFlagProvider } from "@pegma/flags-static";
import type { Logger } from "@pegma/spine";

const schema = declareFlags({
  checkoutEnabled: flag.boolean({ defaultValue: false }),
  theme: flag.string({ defaultValue: "light" }),
  maxItems: flag.number({ defaultValue: 10 }),
  payload: flag.json({ defaultValue: { experiment: "off" } }),
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
    flags: { checkoutEnabled: true, theme: "dark" },
  }),
});

const detail = await client.evaluate("checkoutEnabled", {
  targetingKey: "user-1",
});
```

## Packages

| Package                        | Responsibility                                     |
| ------------------------------ | -------------------------------------------------- |
| `@pegma/flags-contracts`       | Context, detail, reasons, provider port            |
| `@pegma/flags-core`            | Schema, client, cache, timeout, health helper      |
| `@pegma/flags-static`          | In-memory provider for tests and local development |
| `@pegma/flags-azure-appconfig` | Azure App Configuration provider                   |
| `@pegma/flags-launchdarkly`    | LaunchDarkly provider                              |

Remaining vendor adapters (AWS AppConfig, Cloudflare Flagship, flagd)
are named in [the plan](docs/PROJECT_PLAN.md) and stay later.

## Development

Requires Node.js 22 or 24.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
```

Maintainers should follow [the release runbook](docs/RELEASING.md). Releases
publish only from protected signed tags through npm trusted publishing.

## License

MIT © RetireGolden, LLC
