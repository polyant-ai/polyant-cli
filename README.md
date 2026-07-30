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

### `polyant-cli config`

Manage the local, versioned `polyant.yaml`; these commands make no API calls
and never ask for, write, or send a management-key value. `keyEnv` always means
the name of an environment variable.

```bash
# Prompts only for target name, base URL, and key environment-variable name.
polyant-cli config init --target dev --url http://localhost:4000 --key-env POLYANT_KEY_DEV

polyant-cli config validate
polyant-cli config show
polyant-cli config doctor

polyant-cli config target add prod --url https://example.polyant.ai --key-env POLYANT_KEY_PROD --prod
polyant-cli config target default prod
polyant-cli config context add engineering --target dev --org polyant --workspace platform
polyant-cli config context default engineering
```

`init` refuses to replace an existing file unless `--force` is supplied. Every
configuration change first prints a YAML diff and a local `MutationPlan`, then
requires confirmation (or `--yes` in non-interactive automation). Writes use a
temporary file in the same directory followed by an atomic rename. `--dry-run`
prints the plan and makes no write.

Target operations are `add`, `edit`, `remove`, and `default`; context operations
are `add`, `edit`, `remove`, and `default`. To edit a context, pass any subset
of `--target`, `--org`, and `--workspace`. As process-wide options, these flags
may appear before or after the command path.

`doctor` checks only whether each named key environment variable is set. It
reports a missing variable name, never the value.

### `polyant-cli agent`

Manage agents inside one workspace.

**Writes** require an explicit organisation and workspace: select a context, or
pass `--org` and `--workspace`. The CLI never guesses which workspace a change
lands in.

**Reads** may run without one. A management key has no route that lists the
workspaces it may use (`/api/organizations/…` serves human principals only), so
a read without a selection sends no `x-workspace-id`, the engine resolves the
organisation's default workspace, and the CLI says so on stderr. This is a
workaround for a missing engine contract (`GET /api/service-context`), not the
intended end state.

```bash
polyant-cli --context engineering agent list
polyant-cli --context engineering agent show acme
polyant-cli --context engineering agent create acme --name Acme --model claude-sonnet-4
polyant-cli --context engineering agent update acme --model claude-opus-5
polyant-cli --context engineering agent delete acme --yes --confirm acme

polyant-cli --context engineering agent prompt show acme --section identity
polyant-cli --context engineering agent prompt set acme --section identity --file identity.md

polyant-cli --context engineering agent tools show acme --enabled-only
polyant-cli --context engineering agent tools set acme --enable web_search,crm

polyant-cli --context engineering agent channels show acme
polyant-cli --context engineering agent channels set acme telegram --file telegram.json
polyant-cli --context engineering agent channels remove acme telegram --yes --confirm telegram

polyant-cli --context engineering agent hooks show acme
polyant-cli --context engineering agent hooks add acme --file hook.json
polyant-cli --context engineering agent hooks update acme <hookId> --file patch.json
polyant-cli --context engineering agent hooks remove acme <hookId> --yes --confirm <hookId>

polyant-cli --context engineering agent conversations list acme --limit 20
polyant-cli --context engineering agent conversations show acme <conversationId>
```

Reads print an aligned table or a labelled record; `--json` passes the engine's
response body through byte-for-byte, so a pipeline never sees re-serialised
numbers. `agent conversations show --json` emits a composite object whose
`conversation` and `messages` values are the two original bodies.

Writes print a recap on stderr before anything is sent. `tools set` reads its
flag as the *complete* desired selection — the engine replaces the list — and the
recap names what is enabled, disabled, and left alone. `update` and
`prompt set` read the current state first so the recap can show the previous
value, including when a flag changes nothing.

`delete`, `channels remove`, and `hooks remove` are destructive: they require
`--yes` plus `--confirm <slug|type|hookId>`. `--dry-run` prints the recap and
sends nothing.

Channel and hook configuration is accepted only from a named file or stdin
(`--file -`), never from an inline flag where a secret would land in shell
history. `channels show` prints config **key names** only; stored values, masked
or not, are never echoed.

### `polyant-cli monitor`

Current state and live activity. Read-only, so it follows the same workspace
rule as the `agent` reads above.

```bash
polyant-cli --context engineering monitor status
polyant-cli --context engineering monitor events --tool web_search --limit 50
polyant-cli --context engineering monitor events --follow --instance acme
polyant-cli --context engineering monitor stats --from 2026-07-01
```

`status` probes `/health` and the agent list **independently**: whichever one the
engine will not serve is reported as `unavailable — <error>`, never as a zero, so
a broken permission never reads as a healthy empty workspace. Agents with
`authEnabled=false` are flagged on stderr.

`status` prints the whole report and *then* exits non-zero if any probe failed
(`2` for auth/permission, `3` for unreachable or 5xx), so it works as a CI health
gate. That is the opposite of `whoami`, which reports unreachability and still
exits `0` — use `monitor status` when you need the gate.

`events` reads the audit log. With `--follow` it subscribes to the live activity
stream instead: the `--instance` filter is applied **server-side**, the request
carries no deadline (interrupt it, or bound it with `--max <n>`), and `--json`
switches to JSON Lines — one unmodified engine payload per line, so a consumer
can read the stream incrementally.

`polyant-cli agent logs <slug>` is the same query with the instance filter
forced to that agent, including under `--follow`.

### `polyant-cli analytics`

Historical aggregates over the same workspace scope.

```bash
polyant-cli --context engineering analytics overview --from 2026-07-01 --to 2026-07-29
polyant-cli --context engineering analytics agent acme
```

Latency comes from a separate store on the engine: when it is absent the report
says `unavailable` rather than printing a p95 of zero. `--json` passes the
engine's body through unchanged.

### `polyant-cli whoami`

Active target, whether the instance answers, and the agents the key can see.
Add `--json` for a single JSON object.

Permissions come from `GET /api/service-context` when the engine serves it: the
report then names the key's organisation, its effective permission keys, and the
workspaces it may address. That route is a pending engine contract, so until it
lands permissions read `not verified` rather than being guessed — `/api/me/access`
serves user principals only.

The CLI reads exactly that path and requires a top-level `permissions` array of
strings. The organisation is read from `organization` (or `principal.organization`),
and the workspace list, features and key identity are shown when reported. Fields
the engine omits are left out rather than printed as `undefined`.

When the reported workspaces carry no `id`, the report says so: `--workspace`
sends `x-workspace-id`, which takes an id, so a list of slugs alone cannot address
a scoped write.

An answer the CLI cannot read is reported as unverified — an empty list would
claim the key can do nothing, which is a different statement — but a `200` with an
unrecognised shape also prints a warning on stderr, so a contract mismatch is
never mistaken for a missing route.

Any agent with `authEnabled: false` is flagged on stderr: its runtime routes
require no token and validate none.

`whoami` exits `0` whenever it can resolve a target, even against an unreachable
instance — reporting that is its job. Use `monitor status` when you need a gate.

### `polyant-cli api <METHOD> <path>`

Raw passthrough. One command covers every route without wrapping any.

```bash
polyant-cli api GET /api/instances
polyant-cli api GET /api/conversations --query instanceId=acme --query limit=5
polyant-cli api PATCH /api/instances/acme/prompts --data @prompts.json --yes
echo '{"enabled":["webSearch"]}' | polyant-cli api PATCH /api/instances/acme/tools --data - --yes
polyant-cli api DELETE /api/instances/acme --yes --confirm /api/instances/acme
```

Paths start with `/`, and not every route is under `/api`: `/health`, `/v1`,
`/memories`, `/channels/http`, `/webhooks` and `/oauth` are top level.

A `GET` sends immediately. Every other method goes through the same preflight as
the product commands: a recap on stderr naming the target, the method, the path,
where the body came from, and which query keys are set — then a confirmation, or
`--yes` in automation. A production target always needs `--yes`. `DELETE`
additionally needs `--confirm <path>`: an unrecoverable raw call is the one case
worth naming the target twice. `--dry-run` prints the recap and sends nothing.

The recap never prints the body and never parses it. Both directions are
byte-for-byte: the response is printed exactly as received, and the request body
is forwarded exactly as supplied, so a large integer keeps its precision, `1.0`
stays `1.0`, and key order survives. `--data` is still parsed once — and the
result discarded — purely so malformed JSON fails locally instead of as a remote
400.

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
