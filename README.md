# @polyant-ai/cli

`polyant-cli` is the transport between a local coding agent and a Polyant instance.
It resolves a target and its credential, forwards requests to the management
API, and reports results with stable exit codes.

It wraps the management API's routes as commands, but stops short of the request
bodies: a structured payload arrives as `--file <path|->` and is forwarded as
given. The engine owns those schemas, and duplicating them here would guarantee
drift. What the CLI does own is everything around the call — resolving the target
and the credential, recapping a write before it happens, and turning the answer
into an exit code.

The selected target serves interactive API documentation at `/api/docs` and the
raw OpenAPI contract at `/api/openapi.json`. Some request body schemas are not
yet published there; use the route documentation or engine source for those
payloads instead of guessing them.

## Install

Requires **Node 20 or newer** (`engines` enforces it). The package ships
TypeScript sources and compiles on install: `prepare` runs `tsc`, so every route
below builds `dist/` for you — there is no committed build to go stale.

### From the repository, for one workspace

The recommended way. The CLI's version should follow the API version of the
instance it talks to, so pin it per project rather than installing one globally:

```bash
npm i -D git+ssh://git@github.com/polyant-ai/polyant-cli.git#main
```

`#main` is what resolves today: **no release tag has been cut yet.** Once one is,
pin to it instead — `#v0.1.0` — so a project's CLI does not move under it on the
next push to `main`.

That puts the executable in `node_modules/.bin`, which npm scripts and `npx`
already have on their PATH:

```bash
npx polyant-cli --version
```

Inside `package.json` scripts, plain `polyant-cli` works with no prefix:

```json
{ "scripts": { "agents": "polyant-cli agent list" } }
```

### On your PATH, globally

When you want `polyant-cli` in any shell without `npx` — a local operator
console rather than a project dependency:

```bash
npm i -g git+ssh://git@github.com/polyant-ai/polyant-cli.git#main
```

Then `polyant-cli --version` works anywhere. Bear in mind the trade this makes:
one global version now talks to every instance, including ones whose API has
moved on.

### From a local clone

For working on the CLI itself, or installing an unreleased revision:

```bash
git clone git@github.com:polyant-ai/polyant-cli.git && cd polyant-cli && npm install && npm run build
```

`npm install` already builds through `prepare`; the explicit `npm run build` is
there for the rebuild after each edit. Then pick one:

```bash
npm link
```

Links `polyant-cli` onto your PATH pointing **at the clone**, so a `npm run
build` is enough to pick up a change — no reinstall. This is the one to use while
developing.

```bash
npm i -g .
```

Installs a copy instead: a snapshot that does not follow your edits.

If neither appeals, or `npm link` wants permissions you would rather not give it,
an alias needs nothing installed at all:

```bash
alias polyant-cli='node /absolute/path/to/polyant-cli/dist/bin.js'
```

### Check it landed

```bash
polyant-cli --version
```

Prints the package version and the Node version. If the command is not found
after a global install, `npm bin -g` names the directory that has to be on your
PATH.

## Compatibility

The CLI talks to the engine's management API, so its version has to follow the
instance's. There is no negotiation: a route the engine has not shipped answers
`404`, which the CLI reports as a usage error.

| CLI | Engine | Notes |
|---|---|---|
| 0.1.x | the management API as of 2026-08-04 | needs `GET /api/service-context`, `x-workspace-slug`, and `POST /api/instances/:slug/playground/chat/stream` for `agent chat` |
| 0.2.x | 1.1.0 and 1.1.0-ee | adds `agent mcp`, `agent a2a`, `agent memory`, `agent optouts`, `agent events url` and `agent channels whatsapp`; `agent update` gains `--stt-provider` |
| 0.3.x | the first engine release after 1.1.0-ee | adds `monitor ai-logs`, `monitor traces` and `agent messages`; the three routes merged to the engine's develop on 2026-09-01, so against 1.1.0-ee or older all three answer `404` |
| 0.4.x | the same, plus the engine's develop as of 2026-09-02 | adds `workspace skills` and `workspace plugins`; `agent update` gains `--memory-scope`, `monitor events` gains `--conversation`, `agent models` gains a VISION column, and `agent channels show` reports an unreadable config and an engine-side disable |
| 0.6.x | 1.2.0 and 1.2.0-ee, verified against the engine's develop (2026-10-01) | adds `agent budget`, `agent providers`, `agent channels slack url` and `agent conversations show --follow`; `agent checkup` gains `--fail-on`, `monitor status` probes the scheduler, `agent models` lists the embedders and the five-minute cache-write rate, `agent tools show` names a tool's plugin, and `agent secrets` accepts the keys a tool declares. Reads the 1.2.0 plugin and provider lists, where an ungranted row is absent — against 0.5.x those made `workspace providers admit` and `workspace plugins assign` refuse everything |
| 0.5.x | the engine's develop as of 2026-09-14 | adds `org providers`, `org connections`, `workspace providers`, `workspace connections`, `org audit`, `org knowledge`, `workspace knowledge`, `agent shared-knowledge`, `agent checks`, `agent health`, `analytics checks` and `member invitations`; `agent update` gains `--set` and `--provider-connection`, and `whoami` reports which credential is on the header |

Against an engine older than 1.1.0 the commands added in 0.2.0 answer `404`, and
`agent a2a enable` is a `400` — the field does not exist there. Everything else
in 0.2.x works unchanged against 1.0.x.

Three 1.1.0 changes are visible from here even without a new command:

- `agent events show` no longer lists an ingest URL. The token it embedded lets
  its holder drive the agent, so the engine withholds it from a `room:read`
  caller; `agent events url` reveals it, and needs `room:write`.
- `agent tools set` now refuses a tool name neither the registry nor the
  catalogue knows, instead of answering `200` with the change silently undone.
- An empty tool selection means **no tools**, where it used to mean "everything".
  `agent tools set <slug> --none` is now literal.

Four more are visible against the engine's develop, and matter to anything that
parses this CLI's output:

- `GET /api/organizations/:org/plugins` moved off the `org:read` floor onto a
  permission of its own, `org.plugin:read`. A key issued before that split, and
  holding only `org:read`, now answers `403` on `org plugins`.
- The three raw-observability listings count over at most 10001 matching rows and
  report `totalIsCapped` when the count came back at that ceiling. `monitor
  ai-logs`, `monitor traces` and `agent messages` then say "at least 10001"
  rather than restating a number the engine did not measure.
- Those same three resolve a named `--instance` through the caller's accessible
  workspaces: an agent the key cannot reach answers `404` or `403`, where it used
  to answer `200` with an empty list — a false "no traffic" on an observability
  route.
- Retention covers six traffic-driven tables, not two: `tool_audit_logs`,
  `hook_executions`, `scheduled_task_runs` and the completed half of
  `event_backlog` joined `ai_logs` and `pipeline_traces`. `agent retention run
  --count-only` passes the engine's answer through, so the counts it reports are
  wider than they were.

When a command starts answering `404` or `403`, inspect `/api/docs` on the
selected target: it is the engine-owned route catalogue. Some request body
schemas are not yet published, so use the route documentation or engine source
for those payloads. The permission decorator
on the route (`@RequirePermission`, or `@PlatformAdminOnly` for the platform lane)
remains the authority the document is generated from.

Six retention and provider changes on that develop are visible without a new
command:

- A retention policy must state its window. `retention_days` is `NOT NULL` and the
  route refuses a policy without it, so `agent retention set` now rejects a
  payload whose `retentionDays` is null instead of forwarding it. There is no
  deployment-wide default left to inherit: `agent retention show` reports "no
  policy" as "nothing is purged", which is what it now means.
- `PATCH /api/instances/:slug` accepts `providerConnectionId`, and six per-agent
  settings that used to be silently dropped — `datetimeTimezone`,
  `datetimeLocale`, `dedupSimilarityThreshold`, `messageSoftDebounceMs`,
  `messageTypingDelayMs`, `messageMaxRestarts` — are actually persisted. The
  engine still IGNORES a field it does not treat as writable, answering `200`
  with a fresh `updatedAt`, so `agent update` checks the instance it gets back
  and exits `1` on a field that still carries its old value. A value the engine
  normalised counts as written, and `confirmWipe` is not checked because the
  engine acts on it without storing it.
- An organisation's provider credentials became named **connections**, and the
  migration carried each existing secret over as one called "Predefinita", lent
  to every workspace. `org secrets` still works and still describes the old
  shape; `org connections` is where a second credential per provider, or a
  workspace that may not use one, becomes expressible.
- Providers and models are governed on three tiers. `org providers show` reports
  the organisation's admission — a platform-admin decision this key cannot make —
  and `workspace providers` is the half an organisation's own admin owns.
- Documents can live in a library owned by the organisation or by a workspace,
  granted onward and switched on per agent. `agent knowledge` is unchanged and
  still means the agent's OWN documents.
- Eighty mutating routes record what they did, and an organisation can read its
  own trail through `org audit management`.

One family is deliberately absent. Every `/api/platform/*` route — platform
plugins, platform skills, deployment-wide analytics and audit logs — is declared
`@PlatformAdminOnly()`, which admits **only a human principal** whose
`users.is_platform_admin` column is true at the moment of the request. A
management key is not a human principal, so it is refused whatever it holds.

The key is not rejected at the door. `AuthGuard` validates it and resolves the
principal exactly as it does everywhere else; `PermissionGuard` immediately after
it takes the platform-admin lane and refuses. So the answer is
**`403 "Current platform administrator standing required"`** — exit code `2`, not
`401` — and no key, however permissioned, can change it.

**A personal token is refused there too, and for a different reason.** It *is* a
human principal, so the sentence above does not cover it — but that tier bypasses
all authorization and one of its routes returns a generated password in the
response body, so a token sitting in an environment variable would be a bearer
credential for the whole deployment. Every route on the tier refuses one even when
its holder is a platform admin, with
**`403 "A personal API token cannot act as a platform administrator"`**. Reading
the two messages apart is the quickest way to tell which credential your
environment is actually supplying. Those surfaces are
unreachable from any CLI rather than unimplemented here, and are administered from
the web console.

This used to work differently, and the difference is worth naming because the
older description is still in circulation: the gate was `@RequireRole
("platform_admin")` matched against a `users.role` column, and the message was
`403 "Insufficient role"`. The engine dropped that column and deleted its
`RoleGuard`; the flag is now the only authority. Nothing changes for a management
key — it was refused then and is refused now — but the message a caller matches
on, and the reason to give an operator, both did.

The organisation's own `role` commands are a different thing entirely and are
unaffected: they administer **custom org roles**, which the engine still has.

`polyant-cli whoami` is the check: it reports whether the instance answers, the
permissions the key actually holds, and the workspaces it may address. A command
failing with `404` against a reachable instance means that route is older or newer
than this CLI.

## Configuration

`polyant.yaml` at the workspace root is versioned; `.env` is not.

### Which credential goes in `keyEnv`

`X-Polyant-Key` carries two different credentials, told apart by their prefix, and
`keyEnv` names an environment variable holding either one. The CLI sends whichever
it finds — no flag, no code path of its own — but they do not behave the same.

| | `pk_…` management key | `pat_…` personal token |
|---|---|---|
| Authenticates | a service, scoped to one organization | the person who issued it |
| Permissions | an explicit set stored on the key | that person's live role bindings |
| Survives its creator leaving | **yes** | no |

**Use a management key for anything unattended** — CI, cron, a shared runner. A
pipeline authenticated as an employee either breaks the day they are offboarded or
keeps running under an account that should have been closed.

A personal token is for a workstation: your own scripts, on your own authority,
stopping when your access does. It can also be *restricted* to less than you can
do, so a leaked shell profile is not a leaked account. Two consequences to expect:

- Anything the holder cannot do, the token cannot do — and a permission gained or
  lost changes the answer immediately, without reissuing anything.
- The credential-management routes (`POST /api/me/password`, `/api/me/two-factor`,
  `/api/me/tokens`, `/api/invitations/accept`) refuse a personal token outright,
  and so does the whole platform lane below. `api` calls to those answer `403`,
  and that is the engine's decision, not a missing capability here.

**A personal token cannot be issued from here, and neither can a management key
issue one.** `/api/me/tokens` refuses a token (a credential that can mint its
successor survives its own revocation) and refuses a management key too (there is
no user row to attach the token to) — so both of the CLI's credentials are out,
and there is no `polyant-cli token` family to add. Issue one from the account page
in the web console, then put it in the environment variable `keyEnv` names.
`whoami` reports which of the two it found, and with a token names the person it
acts as, since `/api/service-context` is closed to a human principal exactly as
`/api/me` is closed to a machine one.

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

For a selected context, `--target`, `--url`, `--org`, and `--workspace` each
override its corresponding value independently. `--context` overrides
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

`--url` is process-wide, like `--target`: it may appear before or after the
command path, and it retargets every command, not only `api` and `whoami`. When
a `polyant.yaml` is present and `POLYANT_URL` is set, the target error names the
discarded variable and repeats it back as the `--url` to type — the two
mechanisms are easy to confuse from the outside, and silence there costs an
afternoon.

Driving it from a coding agent? Read [AGENTS.md](AGENTS.md) — the exit-code
contract, the `--json` discipline and the confirmation rules — and let the agent
discover the surface with `polyant-cli --json`, which prints the whole command
tree, the global flags and the exit codes as JSON, derived from the dispatcher
rather than maintained by hand.

`polyant-cli --version` prints the installed version and the Node version it runs
on — the two things a bug report needs. `-v` and `version` do the same. It reads
the package manifest, so it cannot disagree with what npm installed, and it makes
no network call: for the instance's reachability use `whoami`.

The engine's own version is not discoverable from here: `GET /health` reports
`status`, `timestamp` and `service`, and no other route carries a version. So
`whoami` does not report one — an unshipped route answers `404` exactly like a
mistyped path, and the CLI names that ambiguity in the error rather than
guessing which side is wrong. Closing it needs a version on the engine's
`/health`.

## Commands

### `polyant-cli config`

Manage the local, versioned `polyant.yaml`; these commands make no API calls
and never ask for, write, or send a credential value — a management key or a
personal token alike. `keyEnv` always means the name of an environment variable.

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

`--workspace` takes a workspace **slug** and is sent as `x-workspace-slug`. The
engine keeps workspace ids off the wire on purpose, so the slug is the only
external identifier; `polyant-cli whoami` lists the slugs the key may address.

The header is sent on every scoped request, and the engine validates it
everywhere: an unknown or inaccessible slug is refused with `403`, so a typo fails
instead of quietly reading somewhere else. It *selects* the result set only where
the workspace is a coordinate — lists, analytics, audit, conversations, the
activity stream. Agent slugs are unique per deployment, so `agent show <slug>`
addresses one agent regardless of the flag; that response reports the workspace
the agent actually lives in, which is how a wrong `--workspace` gets corrected
rather than echoed back.

**Reads** may run without one: the request then carries no workspace header, the
engine resolves the organisation's default workspace, and the CLI says so on
stderr rather than resolving it silently.

```bash
polyant-cli --org acme --workspace platform agent list
polyant-cli --context engineering agent list
polyant-cli --context engineering agent show acme
polyant-cli --context engineering agent checkup acme
polyant-cli --context engineering agent checkup acme --fail-on broken
polyant-cli --context engineering agent create acme --name Acme --model claude-sonnet-4
polyant-cli --context engineering agent update acme --model claude-opus-5
polyant-cli --context engineering agent update acme --memory-scope conversation
polyant-cli --context engineering agent update acme --set memoryEnabled=true
polyant-cli --context engineering agent providers acme
polyant-cli --context engineering agent delete acme --yes --confirm acme

polyant-cli --context engineering agent budget show acme
polyant-cli --context engineering agent budget set acme --file budget.json --yes

polyant-cli --context engineering agent prompt show acme --section identity
polyant-cli --context engineering agent prompt set acme --section identity --file identity.md

polyant-cli --context engineering agent tools show acme --enabled-only
polyant-cli --context engineering agent tools set acme --enable web_search,crm

polyant-cli --context engineering agent channels show acme
polyant-cli --context engineering agent channels set acme telegram --file telegram.json
polyant-cli --context engineering agent channels slack url acme
polyant-cli --context engineering agent channels remove acme telegram --yes --confirm telegram

polyant-cli --context engineering agent secrets show acme --configured-only
printf %s "$OPENAI_KEY" | polyant-cli --context engineering agent secrets set acme --key openai_api_key --file - --yes
polyant-cli --context engineering agent secrets unset acme --key openai_api_key --yes --confirm openai_api_key

polyant-cli --context engineering agent hooks show acme
polyant-cli --context engineering agent hooks add acme --file hook.json
polyant-cli --context engineering agent hooks update acme <hookId> --file patch.json
polyant-cli --context engineering agent hooks remove acme <hookId> --yes --confirm <hookId>

polyant-cli --context engineering agent chat acme --message "quali sono i tuoi tool?"
echo "riassumi la policy di reso" | polyant-cli --context engineering agent chat acme --file -
polyant-cli --context engineering agent chat acme --message "2+2?" --expect 4

polyant-cli --context engineering agent conversations list acme --limit 20
polyant-cli --context engineering agent conversations show acme <conversationId> --follow --max 50
polyant-cli --context engineering agent conversations list acme --from 2026-09-03 --to 2026-09-04
polyant-cli --context engineering agent conversations show acme <conversationId>
polyant-cli --context engineering agent messages acme --from 2026-08-31 --limit 200
```

`agent show` labels provider/model values as stored and effective, so an unset
field does not hide the engine fallback.

`agent messages` reads every conversation of one agent in a single call, where
`agent conversations show` reads one. The table truncates content to 80
characters; `--json` carries it whole.

`conversations list --from/--to` windows by last update, half-open — `--from`
inclusive, `--to` exclusive, so one day is `--from 2026-09-03 --to 2026-09-04`.
The engine's search is relevance-ranked and drops the window, so `--search`
refuses to combine with either rather than answering a narrower question than
the one asked.

`conversations show` names the tools each turn invoked, in step order, in a
`TOOLS` column; a call whose result never came back is marked `?`. The arguments
and the results are unbounded JSON and stay out of the table — `--json` carries
them unchanged.

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
sends no writes. It may still read current state when the recap depends on it;
`prompt set` does this to report the actual character delta.

`agent chat` sends one turn through the **playground** route and
streams the reply. Reply text goes to stdout as it arrives; steps, reasoning and
tool calls go to stderr, so a pipe receives the answer alone. `--json` switches to
JSON Lines — one engine frame per line, tagged with its name and carrying the
original payload. `--expect <text>` exits `1` when the assembled reply does not
contain that text: the tool worked, the scenario did not hold. An `error` frame
exits `3`, because the turn never completed.

When the turn ends, the conversation the engine recorded it in is named on
stderr, so it can be inspected with `agent conversations show` or continued with
`--conversation <id>`.

`/api/instances/:slug/playground/chat/stream` is an **alias** of
`/api/instances/:slug/chat/stream`, not a management lane beside it: the engine
marks both `@Public()` and authenticates both the same way — a per-instance bearer
key, gated on the agent's `authEnabled` flag. The management key is not consulted.
So `agent chat` answers `2` (401) against an agent with `authEnabled` true,
because the CLI holds no runtime agent key; against one with the flag off, the
turn is admitted by the absence of auth rather than by the key. Turn the flag off
on the agent you rehearse against, or drive a closed agent with its own key
through `/v1/chat/completions`.

`agent secrets` is how an agent's provider credentials are set — `openai_api_key`,
`anthropic_api_key`, the `aws_provider_*` trio, and whatever else its tools and
channels declare. The key set is read from the engine per agent, never assumed, so
`secrets show` lists exactly what that agent accepts.

The value comes only from a file or stdin, and **is never printed** — not in the
recap, which reports its length and where it came from, and not on stdout. There
is no `--value` flag: an inline secret lands in shell history and in `ps`.

Both writes refuse a key the agent does not declare, naming the ones it does, and
`unset` additionally refuses a key that is not configured. The engine answers
`200` either way, so without those checks a typo would report success while the
real credential stayed in place.

Channel and hook configuration is accepted only from a named file or stdin
(`--file -`), never from an inline flag where a secret would land in shell
history. `channels show` prints config **key names** only; stored values, masked
or not, are never echoed.

The rest of an agent's surface follows the same shape — a read, and a write that
takes its payload from a file:

```bash
polyant-cli agent skills show acme
polyant-cli agent skills set acme --enable triage,billing --yes
polyant-cli agent skills upgrade acme triage --yes
printf %s "$TOKEN" | polyant-cli agent skills env set acme triage --key ZENDESK_TOKEN --file - --sensitive --yes

polyant-cli agent knowledge list acme
polyant-cli agent knowledge add acme --file faq.md --yes
polyant-cli agent knowledge export acme > kb.json

polyant-cli agent shared-knowledge show acme
polyant-cli agent shared-knowledge enable acme d-1 --yes

polyant-cli agent checks show acme --days 30
polyant-cli agent checks dismiss acme tools-failing --note "known, fix planned" --yes
polyant-cli agent health acme

polyant-cli agent tasks list acme
polyant-cli agent tasks create acme --file digest.json --yes
polyant-cli agent tasks run acme <taskId> --yes

polyant-cli agent events show acme
polyant-cli agent events url acme <id>
polyant-cli agent events rotate acme <id> --yes --confirm <id>

polyant-cli agent mcp show acme
polyant-cli agent mcp set acme github --file github.json --yes
polyant-cli agent mcp test acme --file github.json --server github
polyant-cli agent mcp remove acme github --yes --confirm github

polyant-cli agent a2a show acme
polyant-cli agent a2a enable acme --yes
polyant-cli agent a2a card acme

polyant-cli agent memory list acme --search email
polyant-cli agent memory clear acme --yes --confirm acme

polyant-cli agent optouts list acme
polyant-cli agent optouts opt-out acme --channel whatsapp --contact +391234567890 --yes

polyant-cli agent channels whatsapp url acme
polyant-cli agent channels whatsapp rotate acme --yes --confirm acme

polyant-cli agent retention show acme
polyant-cli agent retention run acme --count-only

polyant-cli agent governance show acme
polyant-cli agent compliance snapshots acme --take --yes

polyant-cli agent models
polyant-cli agent export acme > acme.json
polyant-cli agent import --file acme.json --yes
```

Several of these carry a sharp edge worth stating plainly.

`agent skills set` **replaces** the selection: a skill not listed is disabled, and
the recap says so rather than reading as "enable these".

`agent tasks run` is a real run — it calls the model and delivers to the task's
outbound channel, exactly as the scheduler would.

`agent events rotate` invalidates the current ingest token the moment the new one
is issued, so every producer has to be updated first. The token appears once, in
the response, which is why `events add` and `rotate` print the body whole instead
of a one-line confirmation.

`agent retention run` deletes permanently — the engine has no archive.
`--count-only` is the **engine's** dry run, which really calls it and reports what
it would remove; `--dry-run` is the CLI's, and sends no writes.

`agent import` with a slug **overwrites** that agent — prompts, tools, channels and
hooks are replaced, not merged — and needs `--confirm <slug>`. Without a slug it
creates a new agent in the addressed workspace instead. Same body, opposite blast
radius.

`agent retention show` reports "no policy" as **nothing is purged**. The engine
used to fall back to a deployment-wide window; it does not any more — the column
is `NOT NULL` and `agent retention set` refuses a payload without a positive
`retentionDays`, because the window is the most destructive value in the product
and it is now declared rather than inherited.

`agent update --set <field>=<value>` reaches the writable settings with no flag of
their own — timezone and locale, the debounce and typing delays, the cache TTL,
the opt-out wording. The value is read as JSON when it parses as one, so
`cacheEnabled=true` sends a boolean and `datetimeTimezone=Europe/Rome` a string;
`agent show <slug> --json` lists the field names. The engine ignores a field it
does not treat as writable — with a `200` and a fresh `updatedAt`, which is
exactly the shape that let a panel report a save that never happened — so the CLI
compares the instance it gets back against what it asked for and fails on a field
that did not land.

`agent checks` is the supervision verdict: what the engine has decided is wrong
with an agent, counted over a window of recent activity. That is a different
question from `monitor status`, which reports what an agent IS. The engine serves
check IDs and i18n keys rather than sentences — the same verdicts feed the panel
in every language — so the CLI prints the ID, the severity and the measurement
that raised it. A dismissal stops the check counting at **every** tier, including
`analytics checks` and the organisation's dashboard, and it silences the verdict
and not the cause. `agent health` is the raw per-tool and per-hook counts the
checks are computed from, and it keeps the turns where a gate produced no verdict
apart from the turns a gate blocked: those proceeded with a check that did not
run, and zero there is what tells a quiet agent from a blind one.

`agent mcp set` is a **replacement**, not a patch: the payload needs `name`,
`url`, `authMode` (`none`, `static` or `oauth`) and `config` together, and what
it omits is not kept. The one exception is a credential re-submitted as `••••`,
which the engine restores from what it already holds — so `mcp show --json` can
be edited and sent back without re-typing a token. `mcp show` prints config **key
names** only, the same rule `channels show` follows. `mcp test` persists nothing
and asks for no confirmation, but it does dial the URL, which is why the engine
gates it on `channel:write`; `--server <slug>` lets it borrow a saved server's
credential instead of probing with none.

`agent update --memory-scope` decides how wide an agent's long-term memory
reaches: `agent` is one pool shared by every conversation it serves, and
`conversation` is a pool per conversation. It does **not** migrate what is
already stored — memories keep the key they were written under — so a flip
changes what new turns can recall, not what the agent already holds. The engine
stores a third value, `principal`, reserved for identity work that has not
landed; it refuses to have it set, so the CLI does not offer it.

`agent channels show` distinguishes a config that failed to decrypt from one that
is simply empty: CONFIG KEYS reads `(unreadable)` when the engine could not read
the stored config, which is what a rotated `ENCRYPTION_KEY` looks like. The
AUTO-DISABLED column names why the **engine** turned a channel off — a webhook
that kept rejecting, say — and stays `-` when a person did it, or when nobody
has.

`agent models` reports VISION beside THINKING. It is what decides whether a
channel may hand that model an image: a model without it drops attachments rather
than failing the turn. Both come from the engine's catalog, never from a guess at
the model id.

`agent a2a enable` is an exposure decision, which is why it is not a flag on
`agent update`. The agent card is served **unauthenticated** whenever A2A is on,
and the JSON-RPC endpoint is gated by the agent's own `authEnabled` and nothing
else — so enabling A2A on an agent with authentication off publishes an open LLM
endpoint. The command says so before it writes.

`agent memory clear` and `agent optouts opt-in` both need their subject named
twice. The first is permanent and has no archive. The second resumes messaging
someone who asked to stop: do it on their own request, not to tidy a list.

`agent channels whatsapp url` and `rotate` exist because a channel authenticating
to Twilio with a revocable **API Key** cannot be verified by Twilio's signature —
Twilio signs with the account Auth Token alone — so it receives on a URL carrying
a server-generated secret instead. That secret is bearer-equivalent: `channels
show` withholds it, both routes need `channel:write`, and a `404` means the
channel is not in API-Key mode rather than that the agent is missing. Rotating
invalidates the current URL immediately; update the Twilio Console first.

### `polyant-cli monitor`

Current state and live activity. Read-only, so it follows the same workspace
rule as the `agent` reads above.

```bash
polyant-cli --context engineering monitor status
polyant-cli --context engineering monitor events --tool web_search --limit 50
polyant-cli --context engineering monitor events --conversation conv-1
polyant-cli --context engineering monitor events --follow --instance acme
polyant-cli --context engineering monitor stats --from 2026-07-01
polyant-cli --context engineering monitor ai-logs --instance acme --call-type conversation --limit 50
polyant-cli --context engineering monitor traces --instance acme --from 2026-09-01
```

`monitor ai-logs` and `monitor traces` serve the rows the analytics aggregates
are computed from — one per LLM call and one per turn. `ai-logs` includes calls
that FAILED, which `analytics overview` excludes: summing its cost and
comparing the two yields a real difference, not a bug. Pass `--outcome ok` to
reproduce the aggregate's basis.

Both, and `agent messages` with them, report a **capped** total: the engine
counts over at most 10001 matching rows, so a busy window reports `at least
10001` instead of restating a number nobody measured. Narrow the window when the
exact figure matters. An `--instance` the key cannot reach answers `404` or
`403` on all three; it does not answer an empty list, which would read as an
agent with no traffic.

`monitor events` names the conversation each event belongs to, in a
`CONVERSATION` column. `--conversation <id>` asks the tool audit for one
conversation, which is what lines a turn's tool calls up with `monitor traces`
and `agent messages` for the same id — but the engine drops the parameter today:
`GET /api/audit-logs` declares `instanceId`, `toolName`, `action`, `search`,
`from` and `to`, and nothing else, so the flag is sent, ignored, and answered
with the whole log. Until the route takes it, the column is the filter that
holds. Every audit row also carries the assistant message it served; that is in
`--json` rather than in the table.

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

### `polyant-cli org` · `workspace` · `member` · `role`

Organisation administration. These are organisation-scoped, not workspace-scoped:
the organisation is a path segment, and a management key belongs to exactly one,
so `--org` is a way to be explicit rather than something to look up — without it
the CLI reads the slug from `GET /api/service-context`.

```bash
polyant-cli org list
polyant-cli org create acme --name "Acme Inc"
polyant-cli org rename --name "Acme Inc" --yes
polyant-cli org tasks list

polyant-cli workspace list
polyant-cli workspace create labs --name Labs --yes
polyant-cli workspace update labs --name "Labs v2" --yes
polyant-cli workspace delete labs --yes --confirm labs

polyant-cli member list
polyant-cli member show ada@example.com

polyant-cli role permissions
polyant-cli role list
polyant-cli role show auditor
polyant-cli role create auditor --permissions audit_log:read,analytics:read --yes
polyant-cli role delete auditor --yes --confirm auditor

polyant-cli member set-role u-1 --role admin --yes
polyant-cli workspace bindings
polyant-cli workspace member set labs u-1 --role member --yes

polyant-cli org secrets show
printf %s "$OPENAI_KEY" | polyant-cli org secrets set --key openai_api_key --file - --yes
polyant-cli org plugins

polyant-cli member invitations list --pending-only
polyant-cli member invitations create ada@example.com --role member --workspace labs --yes
polyant-cli member invitations revoke i-1 --yes --confirm i-1

polyant-cli org audit management --action secret.write --actor ada@example.com
polyant-cli org audit authz --workspace labs

polyant-cli org providers show
polyant-cli org providers managed-only --on --yes
polyant-cli org connections list
printf '{"api_key":"%s"}' "$OPENAI_KEY" | polyant-cli org connections create Produzione --provider openai --file - --yes
polyant-cli org connections update c-1 --name Legacy --yes
polyant-cli org connections delete c-1 --yes --confirm c-1

polyant-cli workspace providers list labs
polyant-cli workspace providers admit labs anthropic --yes
polyant-cli workspace providers model labs openai gpt-4o-mini --off --yes
polyant-cli workspace connections assign labs c-1 --yes

polyant-cli org knowledge list
polyant-cli org knowledge add --file ./handbook.pdf --yes
polyant-cli org knowledge grant d-1 labs --yes
polyant-cli workspace knowledge list labs

polyant-cli workspace skills list labs
polyant-cli workspace skills assign labs billing --yes
polyant-cli workspace skills revoke labs billing --yes --confirm billing

polyant-cli workspace plugins list labs
polyant-cli workspace plugins assign labs sales --yes
polyant-cli workspace plugins revoke labs sales --yes --confirm sales
```

`org tasks list` collects every workspace and agent before printing, so its CLI
output is all-or-nothing. The sequential reads are eventually consistent, not a
server-side snapshot.

Workspaces and roles are addressed by **slug** and **key** on the command line,
but the engine's paths for an update or a delete take the row's uuid, so the CLI
resolves the name off the collection first. Workspace deletion is final — the
engine exposes no archive — so it needs `--yes` plus `--confirm <slug>`.

`org secrets` is the organisation-level twin of `agent secrets`: an agent's own
credential wins and this one is the fallback, so ten agents on one OpenAI account
share one key. The engine only offers the keys that can legitimately apply at this
level — an inbound credential like `auth_api_key` authenticates a caller to one
agent and stays per-agent — and the CLI refuses anything outside that set rather
than storing a value that would be silently ignored.

`workspace skills` and `workspace plugins` are the workspace's allow-list: which
of the organisation's skills, and which of its plugins, agents in that workspace
may actually use. What an agent sees is the **intersection** of the
organisation's grant and this assignment. Since engine 1.2.0 the plugin listing
stops at what the organisation holds — an ungranted plugin is absent, not shown
as ungranted — so `workspace plugins list` has only an ASSIGNED column, and a name
missing from it may be ungranted or not installed at all. Assigning a plugin the
organisation does not hold is refused locally rather than written as a row that
changes nothing; the grant itself is a platform-admin action, made from the web
console. `workspace providers list` follows the same rule for providers.

The listings are the whole organisation catalogue with an ASSIGNED column, not
the assigned subset, because "why does this agent not have that skill" is
answered by the row that says `no`. `--assigned-only` narrows it when that is
the question instead.

Two things about the shape. These six routes take the workspace **slug** in the
path, unlike `workspace member`, whose engine paths take the row's uuid — so
there is no id resolution here. And an admin bound only to the workspace being
restricted is **refused**: the allow-list must not be liftable by the person it
restricts, so this needs an organisation-scope binding. Like the rest of
workspace-scoped RBAC they are Enterprise; an OSS engine does not serve them at
all, so there the answer is `404` rather than `403`.

`workspace bindings` is the read side of workspace-scoped RBAC, which is what
actually decides a workspace-scoped permission. It resolves each workspace id back
to its slug. Both it and `workspace member` are Enterprise: on a deployment
without the licensed feature the engine answers `403`, the same shape as a missing
permission — `whoami` lists the features so the two can be told apart.

`member invitations` is how somebody gets INTO the organisation; every other
member command addresses a person who is already in it. The token is printed once
and only its hash is kept, and `emailSent` says whether the invitation was
actually posted — which is exactly when you need the token by hand. An address the
organisation's SSO sign-in list would later lock out is refused at creation rather
than at acceptance, so an invitation that cannot work never exists.

`org audit` reads the two trails the engine keeps apart, and so does the CLI.
`management` is one row per mutating management route — who changed what, and the
metadata the route recorded, which is the only thing that says WHAT changed.
`authz` is who was allowed or refused. A refusal leaves no row in the first and a
successful change leaves none in the second, so folding them together would
produce a stream where an absent row means either. Neither is `monitor events`,
which lists an agent's tool events: what an agent did on a turn, not what a person
did to the configuration. The management trail is not behind the advanced-audit
entitlement — the record of who changed what is the base compliance trail — while
the authorization one is.

`org providers`, `org connections`, `workspace providers` and `workspace
connections` are the provider governance surface, and they are two orthogonal
things. **Admissibility** intersects across three tiers: the platform admits a
provider to an organisation, the organisation admits it to a workspace, and an
agent needs both — so `workspace providers admit` is refused locally for a
provider the organisation does not hold, because the row would change nothing.
Models go the other way: they are switched **off**, never on, at the organisation
or the workspace tier, and either veto is enough, so a catalogue refresh reaches
the tenant that paid for it instead of waiting for someone to enable each model.
**Connections** are named credentials owned by the organisation and lent to
workspaces, so whoever builds an agent picks one by name with `agent update
--provider-connection` and never sees the key. Credentials are read from a file or
stdin, never a flag, and are checked against the shape the engine reports for that
provider before anything is sent. Deleting a connection, or revoking it from a
workspace, **stops** the agents on it rather than falling back to another
credential — a fallback would mean revoking a key revoked nothing while the spend
moved. `org providers managed-only --on` is the switch that makes a named
connection compulsory; turn it on after the connections exist and the workspaces
have them, because an agent carrying its own key stops on its next turn.

`org knowledge` and `workspace knowledge` are the shared libraries, and
`agent shared-knowledge` is the agent's switch over them. A document reaches a
turn only when all three tiers agree: it is in a library, the workspace is granted
it, and the agent has switched it on. This is not `agent knowledge`, which is the
agent's own documents — uploaded to it, deleted with it, reachable by nothing else.
The uploads are the only multipart writes in this CLI, so they take a real path
and not `-`: a multipart part carries a filename and stdin has none.
`agent shared-knowledge show` marks a document the agent cannot use rather than
hiding it — a library indexed with one embedder and an agent configured with
another is the hardest thing to diagnose from a distance — and reports separately
a document that was switched on and later withdrawn, which is a loss to act on.

`org list` is also `org show`: a management key sees one organisation and the
engine serves no per-organisation detail route. `member show` selects locally over
the member list for the same reason, so it costs no extra request.

`role create` checks every permission against `GET …/roles/permissions` before
sending, so a typo fails naming the offending key instead of arriving as an
opaque `400`. `role list` distinguishes "no **custom** roles" from "no roles" —
the system roles are built in and are not listed here.

One limit worth knowing: `member remove` needs a **user** principal, because the
engine grants a management key no rank in the role hierarchy, so with a key it
answers `403`; the recap says so before anything is sent.

### `polyant-cli apikey`

The credential the CLI itself authenticates with. A management key is a database
row now, org-scoped and carrying an explicit permission set, presented as
`pk_<id>_<secret>` in `X-Polyant-Key`.

```bash
polyant-cli apikey permissions
polyant-cli apikey list
polyant-cli apikey create ci --permissions agent:read,agent:write --yes > ci.key
polyant-cli apikey update <keyId> --permissions agent:read --yes
polyant-cli apikey delete <keyId> --yes --confirm <keyId>
```

`create` prints the token on **stdout alone**, once — the engine stores only its
bcrypt hash and cannot show it again — while the recap and the warning go to
stderr, so `> ci.key` captures the token and nothing else. `update --permissions`
REPLACES the set rather than adding to it. Every permission is checked against the
engine's issuable ceiling first. Enterprise, like the bindings above.

### `polyant-cli skill`

The organisation's skill catalog.

```bash
polyant-cli skill list [--owner organization|platform]
polyant-cli skill show triage --content > triage.md
polyant-cli skill set triage --file triage.md --changelog "tighter steps" --yes
polyant-cli skill versions triage
polyant-cli skill export > catalog.json
polyant-cli skill import --file catalog.json --yes
polyant-cli skill delete triage --yes --confirm triage
```

The catalog is the union of the organisation's own skills and the platform-owned
ones granted to it, and two rows can share a name when an organisation
deliberately overrides a platform skill — so `OWNER` is always printed and is not
inferrable from anything else. `skill set` reads the catalog to decide whether it
is creating or versioning, because the engine refuses a create for a name it
already holds; `--description` is required only for the first case. `skill import`
names on stderr anything the engine skipped, which the counts alone hide.

### `polyant-cli governance`

```bash
polyant-cli governance overview
polyant-cli governance analytics [--org-wide]
polyant-cli governance metadata
polyant-cli governance policy list
polyant-cli governance policy create --file policy.json --yes
polyant-cli governance policy delete <id> --yes --confirm <id>
```

Three scopes, kept apart deliberately. The policy **catalog** is owned by the
organisation. `overview`, `tools` and `metadata` answer for the addressed
workspace or the deployment. **Assigning** a policy to an agent is a third thing
again — `agent governance set`. Creating a policy assigns it to nothing.

`governance analytics` covers the addressed workspace; `--org-wide` aggregates every
workspace in the organisation. `governance metadata` is the vocabulary for a
policy payload, including which gate type belongs to which category.

### `polyant-cli dev`

Dev mode: the `*.tool.ts` files on your machine, served into a **remote** agent
for the duration of a turn. The engine equips them as ordinary tools, so ajv
validation, governance, audit and tracing are the real ones.

```bash
# 1. a credential, printed once and never recoverable
export POLYANT_DEV_TOKEN=$(polyant-cli --context engineering dev token issue acme --ttl-hours 4 --yes)

# 2. a project whose node_modules carry tsx and the SDK
polyant-cli dev init ./my-tools --agent acme --yes && (cd my-tools && npm install)

# 3. serve them, until you interrupt it
cd my-tools && polyant-cli --context engineering dev connect acme --watch

polyant-cli --context engineering dev token status acme
polyant-cli --context engineering dev token revoke acme --yes --confirm acme
```

`dev token issue` prints the token on **stdout and nothing else**, so it can be
captured directly; the warning that it is shown once lives on stderr. Issuing
invalidates every previous token for that agent and closes a session connected
with one — `revoke` does the same and is destructive, hence `--confirm <slug>`.

`dev connect` does not terminate. It reads the token from `$POLYANT_DEV_TOKEN`
(or `--token-env <VAR>`, or `--token-file <path|->`) — there is no `--token`
flag, because argv is visible in `ps`. Your tool files are imported by a child
process started with the **project's own** `tsx`, which is why `tsx` and
`@polyant-ai/plugin-sdk` must be dependencies of that project and not of this
CLI: a tool file's `import "@polyant-ai/plugin-sdk"` resolves from where the
file lives. `dev init` writes both.

With `--json` it emits one JSON object per line on stdout, so an agent can read
the session incrementally. Without it, the tool calls are on stdout and the
session's own lifecycle on stderr. Anything your tool prints itself is forwarded
to stderr as `tool: …`. `--watch` reloads the tool set on save (`tools.update`),
keeping the previous set if the reload fails to compile.

It exits `2` for a wrong token, agent or project, `3` for an engine it could not
reach, and `0` when you interrupt it.

A dev session lives in memory on **one** engine node: with more than one
replica, turns served by the others equip no dev tools. Every `dev` read says
so. The permission is `agent.dev:write` (admin and above).

### `polyant-cli whoami`

Active target, whether the instance answers, and the agents the key can see.
Add `--json` for a single JSON object.

It first names **which credential** is on the header, from the key's own prefix
and with no request: a `pk_` management key, a `pat_` personal token, or an
unrecognised prefix said as such rather than assumed. That decides the rest, since
the two reach different identity routes — `/api/service-context` is management-key
only and `/api/me` is the personal token's — so a `403` further on is read against
the credential that actually produced it. With a personal token the report names
the person it acts as instead of the key, and says plainly that permissions are
not verified because that route is not the one a token may read.

Permissions come from `GET /api/service-context` when the engine serves it: the
report then names the key's organisation, its effective permission keys, and the
workspaces it may address. That route is a pending engine contract, so until it
lands permissions read `not verified` rather than being guessed — `/api/me/access`
serves user principals only.

The CLI reads exactly that path and requires a top-level `permissions` array of
strings. The organisation is read from `organization` (or `principal.organization`),
and the workspace list, features and key identity are shown when reported. Fields
the engine omits are left out rather than printed as `undefined`.

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
worth naming the target twice. `--dry-run` prints the recap and sends no writes.

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

`npm link` puts the working copy on your PATH — see [Install](#from-a-local-clone)
for the difference between that and `npm i -g .`.

Before each engine release, `/engine-release-sync` in Claude Code
(`.claude/skills/engine-release-sync/`) diffs the engine's `develop` against the
engine this CLI last matched, proposes what to update, add, remove and modify,
and proves the changes against a throwaway engine it starts and removes itself.
