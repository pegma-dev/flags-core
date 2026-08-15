# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Flags Core is a component of **Pegma**, a family of MIT-licensed packages a
host application composes. Shared contracts live in `@pegma/spine`. They
publish under the `@pegma` scope, one repository per component.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

This package's whole value is a typed evaluation client a host can inject and
an adapter can implement without inventing a control plane. A change that
owns authoring, invents a rule language, or silently falls back is worse
than no package at all.

## Hard rules

**Read and evaluate; never author.** This component does not own a flag
control plane, an admin UI, or `@pegma/flags-storage`. If a change here
needs to persist flag definitions or render an editor, the design is wrong.

**Do not invent a rule language.** Targeting, percentage rollouts, and
predicate evaluation belong in the provider or in an open standard such as
flagd / OpenFeature. An internal AWS/AppConfig-style document evaluator is
out of scope even if a draft spec asked for one.

**Clients are constructed and injected.** No global singleton, no ambient
AsyncLocalStorage context, no "get the current client from the environment."
The host owns the instance.

**Evaluation must not block on the network.** Bound every provider call with
a timeout. On timeout or error, return the default (or a still-valid stale
cache) with an explicit reason. Never wait unbounded on the request path.

**No silent fallback.** `createFlagsClient` requires an injected Spine
`Logger`. Every fallback — including a cached `DEFAULT_FALLBACK`,
`DISABLED`, or `ERROR` — emits a log line and an `EvaluationDetail.reason`.
A default returned without both is a bug. Do not default to `noopLogger`.

**Import shared types from spine; pin `@pegma/*` deps exactly.**
`PrincipalId`, `Clock`, and `Logger` come from `@pegma/spine`. A caret would
let CI resolve a version nobody tested against.

**Never write literal control characters into source.** Write them as escape
sequences such as backslash-u-0000 through backslash-u-001F, and verify the
bytes after any tool-assisted edit.

## Packaging traps already paid for

Each published package needs its **own** README and LICENSE inside the package
directory; npm ignores files at the repository root. Each needs `prepack`
running the build. Each package `tsconfig.json` must exclude
`src/**/*.test.ts`, or compiled tests ship to consumers.

`runNpm` must invoke a real npm CLI. When this script is launched via
`pnpm run`, `npm_execpath` points at pnpm — delete it, or pack/publish
silently go through pnpm.

## Workflow

Work on a `claude/*` branch and open a pull request. The gate is
`pnpm run format:check`, `pnpm run check`, `pnpm test` — all three, on Node 22
and 24.

Publishing is trusted-publisher only; no tokens exist. A release starts from a
protected signed annotated `vX.Y.Z` tag already on `origin/main`, followed by
`gh release create vX.Y.Z --verify-tag`. The unprivileged preparation job runs
the gate and packs the exact artifacts; only the minimal publish job receives
OIDC authority. See `docs/RELEASING.md`. Do not publish from this Phase 3
scaffold.

## Where things stand

Phase 3 lands `@pegma/flags-launchdarkly` and
`@pegma/flags-aws-appconfig` beside the Phase 1 packages and
`@pegma/flags-azure-appconfig` at `0.1.0` (unpublished). Remaining
vendor adapters (Cloudflare Flagship, flagd) are still later.

Siblings: [spine](https://github.com/pegma-dev/spine),
[health](https://github.com/pegma-dev/health),
[scheduler](https://github.com/pegma-dev/scheduler).
