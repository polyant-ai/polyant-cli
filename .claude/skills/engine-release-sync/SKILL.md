---
name: engine-release-sync
description: Align the CLI's develop with the next Polyant engine release — diff the engine since the CLI's last sync, change the CLI, prove it against an ephemeral engine.
disable-model-invocation: true
---

# Engine release sync

The CLI drives the engine's management API with no version negotiation, so every
engine release can break a command silently: a route that moved answers 404, but a
response that changed shape answers 200 and the CLI misreads it. This skill finds
both kinds of change in the engine's next release and lands the CLI changes they
need on `develop`, proven against a live engine.

The engine lives in its own repository. `ENGINE_DIR` names the checkout to work
against (default: a `polyant` checkout beside this one). The CLI also covers
Polyant Enterprise, a superset of the OSS engine: when you maintain those commands,
point `ENGINE_DIR` at an Enterprise checkout, whose routes cover both, and read the
OSS repository only for its release notes. In either repository the next release
is `origin/develop` and the current one is `origin/main`.

## 1. Baseline — what the CLI last matched

Read the top row of the README's Compatibility table and the most recent
`feat:`/`chore(release):` commit bodies on `origin/develop`. They name the engine
the CLI was last verified against: a release tag, or "develop as of <date>", or a
SHA. Turn it into an engine SHA (`git log --first-parent origin/develop
--until=<date>` when it is a date), and into an OSS SHA too when `ENGINE_DIR` is
an Enterprise checkout.

Also compare the CLI's own branches: `git log origin/develop..origin/main` lists
CLI work that never came back to develop. It is merged first, in step 5.

**Done when** you hold the engine SHA (and the OSS SHA, when they differ), and can
say in one line why each is the right one.

## 2. Inventory — what changed in the engine

From the baseline to `origin/develop`, in `ENGINE_DIR`:

- `scripts/routes.sh <repo> <rev>` at both revisions, then `diff`: routes added and removed.
- `docs/releases/v*.md`, `docs/UPGRADING.md` and `CHANGELOG.md` on develop, both repos: the intent, the breaking changes, the migrations.
- `git log --first-parent <base>..origin/develop`: the PRs, for their bodies.
- `git diff <base> origin/develop` on `packages/engine/src/server/**` controllers and services, and on any store or schema behind a route the CLI calls. Find what the CLI calls with `polyant-cli --json` and by grepping `src/` for paths.

A changed response is where the regressions hide. Look for, in every diff a CLI
command reads:

- a field removed or renamed — the CLI reads `undefined` and prints "no", or refuses locally. Grep `src/` for every field name a diff removes;
- a row set narrowed (rows now ABSENT where they were flagged) — absence becomes the signal;
- auth decorators added (`@SessionCredentialOnly`, `@PlatformAdminOnly`, `@PlatformAdminPersonalToken`, a new `@RequirePermission`);
- bodies turned strict (`z.object(...).strict()`) — an extra field the CLI sends becomes a 400;
- new writable fields on an entity, new defaults, settings moved from env vars into the product;
- lists the CLI validates against that no longer hold every accepted value.

**Done when** every route added or removed, and every diff under a route the CLI
calls, is accounted for as one of: needs a CLI change, needs nothing (say why), or
out of scope (`/api/platform/*`, inbound webhooks, credentials the CLI does not hold).

## 3. Proposal — the four lists

Report to the user, grouped as **update** (version, docs, dependencies,
back-merges), **add** (commands for new routes), **remove**, **modify** (commands
that misbehave against the new engine — first, they are the regressions). One line
per item, with the engine PR or file that motivates it. Say what you left out.

**Done when** the user has approved the list. Implement nothing before.

## 4. Ephemeral engine

```bash
scripts/ephemeral-up.sh [rev]        # default origin/develop; prints the CLI wrapper path
```

It runs the engine in `ENGINE_DIR` at `rev` from a detached worktree with its own
Postgres (`:55499`) and port (`:4499`), mints an admin session, and issues a
management key and a personal token. Issuing them takes the key routes Polyant
Enterprise serves: the OSS engine accepts a management key but has no route that
issues one, so against an OSS checkout the script stops at its credentials step.
The wrapper `pc` runs this worktree's `dist/` against it;
`--target ephemeral-pat` switches to the personal token. `$WORKDIR/session.tok` is
a browser-equivalent admin session for platform routes the CLI cannot reach
(granting dev mode, a plugin, a provider): `curl -H "Authorization: Bearer $(cat
$WORKDIR/session.tok)"`. `scripts/ephemeral-down.sh` removes all of it.

Probe each route from step 2 with `pc api GET …` before writing code: the live
answer settles a shape faster than the source, and catches an engine bug the CLI
should not paper over.

**Done when** `pc whoami` reports `reachable: yes` and every new route has answered once.

## 5. Implement on a branch from `origin/develop`

Merge `origin/main` first if step 1 found CLI work missing from develop. Then the
approved list, **modify** items first, each with unit tests in the style of the
neighbouring `*.test.ts`. Follow `AGENTS.md`'s rules: secrets and payloads from
`--file`, recaps on stderr, exit codes by meaning, `--json` byte-for-byte.

**Done when** `npm test`, `npm run typecheck` and `npm run build` are green.

## 6. Prove it live

```bash
node scripts/smoke.mjs <wrapper> <agentSlug> [workspaceSlug]
```

Create an agent first (`pc --org default --workspace general --yes agent create
acme --name Acme`). The smoke runs every read-only leaf that needs only a slug,
from the live command tree. A non-zero exit there is either an empty state the
engine refuses (an unconfigured channel, A2A off) or a bug — name which, for each.

Then exercise by hand every command you added or changed, writes included, with
`--dry-run` and for real. Give the engine the state each needs: a conversation (an
`agent chat` turn creates one even without a provider key), an org secret, a
granted plugin, a connection.

**Done when** each changed command has run against the engine with the outcome you
expected, and every smoke failure is explained.

## 7. Release the CLI version

Bump `package.json` and `package-lock.json` (`npm version <x.y.0>
--no-git-tag-version`); add the Compatibility row naming the engine release and
the date of the engine develop you verified against, which is the next run's baseline; update
the README examples and `AGENTS.md`'s "Where to start". Commit: code with tests,
then docs and version. Commit on the branch; push and open the PR when the user
asks.

## 8. Report

Lead with the state: what works against the new engine and how it was verified.
Then engine bugs found along the way (with file and line in the engine) and what
the CLI does about each — they belong to the engine team, not to a CLI workaround.
Then run `scripts/ephemeral-down.sh`.
