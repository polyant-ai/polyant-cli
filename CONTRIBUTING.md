# Contributing to polyant-cli

Thank you for your interest in contributing. This document covers what you need to
send a change.

## Prerequisites

- **Node.js 20 or newer** — the floor declared in `engines`, and the version CI
  runs on.
- A Polyant instance to try a change against, when the change talks to the engine.
  Unit tests need none.

## Local setup

```bash
git clone https://github.com/polyant-ai/polyant-cli.git
cd polyant-cli
npm install        # builds dist/ through `prepare`
npm link           # optional: puts this working copy on your PATH
```

## Checks

Run these before opening a pull request; CI runs the same ones:

```bash
npm run typecheck
npm test
npm run build
node dist/bin.js --version
```

## Conventions

Read [`AGENTS.md`](AGENTS.md) before changing a command: it is the contract the CLI
keeps with the people and agents that drive it. In particular:

- Secrets and structured payloads arrive through `--file <path|->`, never a flag.
- Recaps, progress and warnings go to stderr; stdout carries the answer.
- Exit codes carry meaning (`0` success, `1` a failed check, `2` usage or
  configuration, `3` a retryable remote failure). Keep them.
- `--json` output passes the engine's response through byte for byte.
- A new or changed command comes with unit tests in the style of the neighbouring
  `*.test.ts`, and updates the README and, where it applies, `AGENTS.md`.
- Every source file carries the header `// SPDX-License-Identifier: Apache-2.0`.

## Sign your work (DCO)

polyant-cli uses the [Developer Certificate of Origin](https://developercertificate.org/)
for contributions, instead of a Contributor License Agreement.

Every commit must include a `Signed-off-by` line. Sign your commits with:

    git commit -s -m "feat: my change"

This appends a line like:

    Signed-off-by: Your Name <your.email@example.com>

The `-s` flag uses your `git config user.name` and `user.email`. If you forgot to
sign a previous commit, amend it with:

    git commit --amend -s --no-edit

Or rebase to add sign-off to a range of commits:

    git rebase --exec "git commit --amend -s --no-edit" develop

Pull requests without sign-off on every commit are not merged.

## Pull request process

1. Branch from `develop` and open the pull request against `develop`, with a title
   in [Conventional Commits](https://www.conventionalcommits.org/) format.
2. Describe what changes, why, and how you tested it.
3. CI must pass.
4. Every commit must be signed off (see above).
5. A maintainer reviews it before merge.

## Licence

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the licence of this project.
