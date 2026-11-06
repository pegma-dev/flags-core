# Release operations

`@pegma/flags-contracts`, `@pegma/flags-core`, `@pegma/flags-static`,
`@pegma/flags-azure-appconfig`, `@pegma/flags-aws-appconfig`,
`@pegma/flags-cloudflare-flagship`, `@pegma/flags-flagd`, and
`@pegma/flags-launchdarkly`
publish
only from a stable GitHub release. Merging a pull request never
publishes, and the workflow has no manual-dispatch or npm-token
fallback. Phase 3 does not publish; this runbook exists so the first
release does not invent a lane.

## Required external configuration

Before the first release through this workflow:

- configure `@pegma/flags-contracts`, `@pegma/flags-core`,
  `@pegma/flags-static`, `@pegma/flags-azure-appconfig`,
  `@pegma/flags-aws-appconfig`, `@pegma/flags-cloudflare-flagship`,
  `@pegma/flags-flagd`, and `@pegma/flags-launchdarkly` on npm with
  the GitHub Actions trusted publisher
  `pegma-dev/flags-core`, workflow `publish.yml`, environment
  `npm-publish`, and allowed action `npm publish`;
- create the GitHub `npm-publish` environment. A second reviewer is not
  required under Pegma's single-maintainer policy;
- create the repository Actions variable `RELEASE_ALLOWED_SIGNERS` containing
  the reviewed Git SSH allowed-signers entry for the maintainer's release key;
  this is public-key material, not a secret; and
- create an active tag ruleset targeting `v*` that prevents tag updates and
  deletions and limits tag creation to the release maintainer.

Do not add `NODE_AUTH_TOKEN`, an npm automation token, or another credential
fallback. After one trusted-publisher release is verified, disable any
remaining traditional npm publish tokens.

## Release procedure

The versions in `packages/*/package.json` are the release versions. Change
them through an ordinary reviewed pull request and run the complete gate on
Node 22 and 24.

After that pull request is merged, create a signed annotated tag at the exact
`origin/main` commit, push the tag, verify the fetched tag, and only then
create the GitHub release with `--verify-tag`. Do not let GitHub create the tag
and never move or recreate a release tag.

Before any checkout or dependency command, the release workflow fetches only
`main` and the named tag into a temporary bare repository and verifies that
the tag:

- is a stable annotated `vX.Y.Z` tag signed by an allowed signer;
- matches a public package version;
- points to the checkout and the GitHub release-event commit; and
- is contained in `origin/main`.

The checkout then uses the immutable release-event commit rather than the tag
name. The preparation job has no OIDC permission. It installs the reviewed npm
`11.18.0` release and the pinned pnpm without dependency caching, runs the
full gate, builds and packs once with that npm CLI, revalidates each packed
manifest, records SHA-1, SHA-256, and SHA-512 integrity, seals the exact
release-directory inventory, and uploads the prepared artifacts. The lockfile
source of truth is `pnpm-lock.yaml`.

A separate unprivileged job downloads that artifact and installs every
tarball into a clean consumer before importing every public export. Only the
`npm-publish` job receives `id-token: write`. That job authenticates the tag
again, checks out no repository content, installs no project dependencies,
and does not download pnpm. Workflow-owned code verifies the prepared
manifest digest, exact file inventory, and tarball hashes, then publishes from
an isolated temporary directory with npm provenance.

## Safe retry

The workflow is globally serialized. Re-run the failed release jobs against
the unchanged tag:

- an absent version is published;
- an existing version with identical `dist.integrity` is verified and skipped;
- a different integrity, or any registry error other than `E404`, stops the
  release.

Never unpublish and reuse a version. If any released byte must change, prepare
a new version and a new signed tag.
