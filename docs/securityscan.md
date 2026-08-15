# Security Scan Report

**Date:** 2026-08-15
**Scope:** Repository-wide security review of the Phase 1 flags-core
workspace (`@pegma/flags-contracts`, `@pegma/flags-core`,
`@pegma/flags-static`)
**Method:** Manual source review, dependency audit, CI/CD workflow review,
configuration review. No files were modified other than this report.

## Findings

_Findings are appended below as the scan progresses._

---

## Areas reviewed with no findings

- **Dependency audit:** `@pegma/*` dependencies are pinned exactly (no
  caret ranges), per policy. `@pegma/flags-static` depends only on
  `@pegma/flags-contracts`.
- **Secret scan:** No API keys, tokens, connection strings, `.env`, `.pem`,
  or `.key` files tracked in git. `.gitignore` excludes `.env*`. Trusted
  publishing is OIDC-only; `id-token: write` is confined to the `publish`
  job (enforced by a test in `tests/release-packages.test.ts`).
- **CI/CD workflows** (`.github/workflows/ci.yml`, `codeql.yml`,
  `publish.yml`): all actions pinned to full commit SHAs; minimal
  `permissions:` blocks (`contents: read` by default); no
  `pull_request_target`, no `workflow_dispatch` on publish.
- **Release script** (`scripts/release-packages.mjs`): signed annotated-tag
  verification with an allowed-signers file, timing-safe comparisons for
  commits/hashes, tarball hash re-verification before publish, tarball
  allowlist (`package.json`, `README.md`, `LICENSE`, `dist/` only), smoke
  test uses `--ignore-scripts`, publish restricted to the GitHub release
  event with npm provenance, no token fallback. `runNpm` deletes
  `npm_execpath` so pack/publish cannot silently go through pnpm.
- **Packaging:** each public package `files` allowlist covers only `dist/`;
  `prepack` builds; each package `tsconfig.json` excludes
  `src/**/*.test.ts`; `sideEffects: false`. Root `package.json` is private.
- **Control characters:** No literal control characters (U+0000–U+001F)
  found in any tracked source file, per the repository hard rule.
- **Evaluation fallbacks:** timeout and provider errors map to `ERROR` or
  `STALE_CACHE` with a logger line; missing keys map to
  `DEFAULT_FALLBACK` with a logger line. Public detail does not include
  raw provider exception text.
- **TypeScript config:** `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noEmitOnError` enabled.

## Summary

| ID  | Severity | Finding             | Status |
| --- | -------- | ------------------- | ------ |
| —   | —        | No Phase 1 findings | —      |

**Scan completed:** 2026-08-15. No files other than this report were
modified.
