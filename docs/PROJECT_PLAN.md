# Flags Core Project Plan

## Status

**Stage:** Phase 2 implemented in-tree; unpublished. Public API unstable
(`0.x`).

**First named consumers:** RetireGolden.org (Azure App Configuration).
Remaining vendor adapters stay gated on a real host that needs them.

**License:** MIT

**Dependencies:** `@pegma/spine` pinned exactly. This component reads and
evaluates; it does not take a `Store` and does not own flag records.

## Vision

Every host eventually evaluates a boolean, a string, a number, or a JSON
blob under a targeting key. Hand-rolled wrappers diverge: one blocks the
request on a provider SDK, another swallows errors as `false`, a third
invents a mini language so AppConfig documents can be interpreted in
process. The failure is quiet — a default served as if it were targeted
truth — and it surfaces as a wrong checkout, never as an error.

One evaluation client, provider-agnostic, whose schema, context, detail
reasons, timeout, and cache are the component — so a host wires an adapter
and gets the part everyone gets wrong, already honest.

## Where it sits in the stack

Beside two jobs this repository deliberately refuses:
[`@pegma/health`](https://github.com/pegma-dev/health) probes process and
storage liveness; storage-core persists host records. Neither evaluates
flags. A typical host pipeline: incoming request → host builds
`EvaluationContext` (targeting key, optional Spine `PrincipalId`, tenant /
environment) → **flags-core (timeout, cache, codec, reason)** → provider
adapter (LaunchDarkly, AppConfig, flagd, or the static map). There is no
`@pegma/flags-storage` and no authoring UI in this family.

## Fundamental model

**Flag schema** — a host-declared map of keys to `flag.boolean`,
`flag.string`, `flag.number`, or `flag.json`. `declareFlags` infers the
client surface at compile time; each definition carries a default and a
runtime codec so a provider payload of the wrong kind cannot become a
silent `true`.

**Evaluation context** — `targetingKey` plus optional `principalId`
(Spine), `tenant`, `environment`, and host attributes. The client never
reads ambient request state.

**Evaluation detail** — `EvaluationDetail<T>` always includes `value` and
`reason`: `TARGETING_MATCH`, `DEFAULT_FALLBACK`, `DISABLED`,
`STALE_CACHE`, or `ERROR`. The value may be the default; the reason must
still say why.

**Snapshot cache** — a process-local TTL map keyed by flag + targeting
identity. Fresh hits return the stored reason. Stale hits return
immediately as `STALE_CACHE` and refresh in the background. A miss calls
the provider under a timeout; a timeout or throw falls back and logs.

**Provider port** — `FlagProvider.resolve` is the only required method.
Capabilities and change events exist so later streaming adapters can
advertise themselves without changing the client constructor.

## Design decisions

### No custom rule language

Rule evaluation belongs in the provider or in an open standard (flagd,
OpenFeature). An internal AWS/AppConfig-style document interpreter would
make this repository a second source of targeting truth and is refused
even if an earlier draft asked for one. Adapters translate; they do not
re-implement percentage rollouts here.

### Constructed clients, never ambient ones

A global `getClient()` looks convenient and hides the composition root.
Pegma requires the host to construct and inject the client. Tests pass a
static provider; production passes a vendor adapter.

### Timeout then fallback, never a hung request

Provider SDKs hang. The client bounds every resolve. When the budget
expires, the default (or a still-usable stale entry) is returned with
`ERROR` or `STALE_CACHE`, and the injected logger gets a line. There is
no path that returns a default without both a reason and a log.

### `@pegma/flags-storage` is not a package

This component does not own a control plane. Authoring, approval, and
rollout configuration stay with the vendor or the host. Naming a storage
package here would invite the wrong extractions.

## Scope

### In scope

- Contracts, typed schema, client, cache, timeout, health helper.
- Static in-memory provider for tests and local development.
- Conformance suite every later adapter must pass.

### Non-goals

- Flag authoring, admin UI, or a Pegma-owned flag store.
- A custom expression / rule language or AppConfig document evaluator.
- Vendor adapter packages before a named consumer needs them.
- Metrics, experiment assignment, or percentage math in the core.

## Package architecture

| Package                            | Responsibility                     | Phase |
| ---------------------------------- | ---------------------------------- | ----- |
| `@pegma/flags-contracts`           | Context, detail, provider port     | 1     |
| `@pegma/flags-core`                | Schema, client, cache, conformance | 1     |
| `@pegma/flags-static`              | Zero-dep in-memory provider        | 1     |
| `@pegma/flags-launchdarkly`        | LaunchDarkly adapter               | later |
| `@pegma/flags-azure-appconfig`     | Azure App Configuration adapter    | 2     |
| `@pegma/flags-aws-appconfig`       | AWS AppConfig adapter              | later |
| `@pegma/flags-cloudflare-flagship` | Cloudflare Flagship adapter        | later |
| `@pegma/flags-flagd`               | flagd / OpenFeature adapter        | later |

Dependencies: `@pegma/spine` pinned exactly. `@pegma/flags-static` and
`@pegma/flags-azure-appconfig` depend only on `@pegma/flags-contracts`
(no vendor SDK). Adapters pin contracts (and spine, if they need
`Logger` / `Clock`) exactly.

## Delivery phases

### Phase 1 — contracts, client, static provider (this repository)

Schema helpers, evaluation client with timeout and stale-while-revalidate,
static provider, conformance suite (boolean / string / number / json,
missing key → `DEFAULT_FALLBACK`, targeting key present, timeout and
error reasons, no silent fallback). Org-standard workspace. No npm
publish.

### Phase 2 — first vendor adapter, gated on a consumer

`@pegma/flags-azure-appconfig` for RetireGolden.org. The adapter
translates App Configuration settings through an injected reader and
must pass the Phase 1 conformance suite. It does not evaluate targeting
filters or percentage rollouts, and it rejects an enabled document that
still carries those rules. Do not pre-build the other vendors.

### Phase 3 — remaining adapters

LaunchDarkly, AWS AppConfig, Cloudflare Flagship, and flagd, each as
its own package, each gated the same way.

### Phase 4 — publish

Trusted-publisher npm release from a signed `vX.Y.Z` tag on `main`, once
a consumer is ready to take a versioned artifact. See
[RELEASING.md](RELEASING.md).

## Open questions

**JSON codec strictness.** Phase 1 accepts JSON-compatible values and an
optional host `decode`. A branded schema library is deferred until a
consumer brings one.

**Cache key attributes.** The snapshot key is flag + targeting key +
tenant + environment, with omitted fields encoded separately from empty
strings so identities cannot collide. If a host needs attribute-sensitive
caching, that is an adapter concern (the provider already saw the
attributes); do not hash arbitrary attribute maps in the core unless two
consumers require it.

**Streaming invalidation.** `FlagChangeEvent` is on the port so a later
adapter can drop cache entries. Phase 1 does not subscribe automatically;
the host may call `subscribe` and `invalidate` when it wants to.
