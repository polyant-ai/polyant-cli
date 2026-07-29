# @polyant-ai/cli

`polyant-cli` is the transport between a local coding agent and a Polyant instance.
It resolves a target and its credential, forwards requests to the management
API, and reports results with stable exit codes.

It is deliberately thin: it does not wrap the API's routes, and it does not
validate request bodies. The engine owns those schemas, and duplicating them
here would guarantee drift.

## Install

Pin it per workspace rather than installing it globally — the CLI's version
should follow the API version of the instance you talk to.

```bash
npm i -D git+ssh://git@github.com/polyant-ai/polyant-cli.git#v0.1.0
```

## Configuration

`polyant.yaml` at the workspace root is versioned; `.env` is not.

```yaml
default: staging
defaultContext: engineering

targets:
  staging:
    baseUrl: https://staging.example.polyant.ai
    keyEnv: POLYANT_KEY_STAGING   # the NAME of the env var, never the value
  prod:
    baseUrl: https://example.polyant.ai
    keyEnv: POLYANT_KEY_PROD
    prod: true                     # enables the guard rails on writes

contexts:
  engineering:
    target: staging
    org: polyant
    workspace: platform
  production:
    target: prod
    org: polyant
    workspace: platform
```

A context is a versioned, non-secret shortcut for a target, organization, and
workspace. `defaultContext` selects it when `--context <name>` is absent. A
literal `key:` is rejected: a token in a versioned file is a leak. Keys are
read only from the environment variable named by `keyEnv`, and there is no
`--key` flag, because argv is visible in `ps` and lands in shell history.

For a selected context, `--target`, `--org`, and `--workspace` each override
its corresponding value independently. `--context` overrides
`defaultContext`. When neither flag nor context supplies a target,
`POLYANT_TARGET`, then `default`, then a sole declared target are considered.
`POLYANT_URL` and `POLYANT_KEY` remain the no-config fallback; there are no
environment fallbacks for organization or workspace, so a command that needs
them requires an explicit flag or a selected context.

Without a `polyant.yaml`, `polyant-cli` runs on `POLYANT_URL` and
`POLYANT_KEY` alone for target-only commands.

`POLYANT_URL` applies **only** in that no-workspace case. Once `polyant.yaml`
declares a target, a stray `POLYANT_URL` in the environment is ignored: letting
it retarget a named target would keep that target's key and its `prod` flag
while pointing somewhere else, so a write landing on a production host could be
labelled as staging. `--url` still overrides the host, because typing it is
per-invocation intent — but it too keeps the target's key and `prod` flag, so
prefer declaring a target over reaching for the flag.

## Commands

### `polyant-cli whoami`

Active target, whether the instance answers, and the agents the key can see.
Add `--json` for a single JSON object.

A management API key cannot introspect its own permissions — `/api/me/access`
serves only user principals — so permissions are reported as not verified
rather than guessed. Any agent with `authEnabled: false` is flagged on stderr:
its runtime routes require no token and validate none.

### `polyant-cli api <METHOD> <path>`

Raw passthrough. One command covers every route without wrapping any.

```bash
polyant-cli api GET /api/instances
polyant-cli api GET /api/conversations --query instanceId=acme --query limit=5
polyant-cli api PATCH /api/instances/acme/prompts --data @prompts.json
echo '{"enabled":["webSearch"]}' | polyant-cli api PATCH /api/instances/acme/tools --data -
```

Paths start with `/`, and not every route is under `/api`: `/health`, `/v1`,
`/memories`, `/channels/http`, `/webhooks` and `/oauth` are top level.

## Output and exit codes

stdout carries only parsable data; diagnostics, progress and warnings go to
stderr. Every mutation prints its target host on stderr before it is sent.

| code | meaning |
|------|---------|
| `0` | success |
| `1` | a difference, or a failed assertion — not a tool error |
| `2` | configuration, usage or authentication (4xx except 429, missing target, absent key) |
| `3` | remote: 5xx, 429, timeout, unreachable host — transient, so retryable |

`429` is `3`, not `2`: it is worth retrying.

Two exceptions worth knowing. `whoami` exits `0` even when the instance does not
answer — reporting that is the command's job, so read its `reachable` field
rather than its exit code; use `polyant-cli api GET /health` if you want a health
gate that can fail. And a malformed URL is a `2`, not a `3`: retrying a URL that
can never parse is pointless.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```
