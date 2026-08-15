# Contributing to Flags Core

Thank you for helping improve Flags Core.

## Before opening an issue

- Search existing issues for related work.
- Use GitHub's private vulnerability reporting flow for security concerns.
- Describe the evaluation behavior you need and which reason must be
  returned, not only the API shape you would like.
- If a proposal needs this package to own flag authoring, invent a rule
  language, or add a global client, say so explicitly — those are the
  changes the design cannot absorb.

## Local development

Flags Core requires Node.js 22 or 24.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run format:check
```

## Pull requests

Keep pull requests focused. Include:

- the problem being solved;
- the intended component behavior;
- tests for new behavior;
- documentation for public API changes.

A new provider must pass the conformance suite. Fallback paths must include
a test that a log line and an evaluation reason are both present.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.
