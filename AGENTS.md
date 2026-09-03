# polyant-cli for agents

`polyant-cli` is the management console for a Polyant platform: agents, their
prompts, tools, channels, hooks and secrets, plus observability, analytics and
organisation administration. It is built to be driven by a coding agent, not only
by a person.

Read this file before running it. Then discover the surface from the tool itself
rather than from this document:

```bash
polyant-cli --json
```

That prints the whole command tree, the global flags and the exit codes as JSON.
It is derived from the dispatcher, so it cannot describe a command that does not
exist or omit one that does — which is why it, not this file, is the source of
truth for what is available.

## The five rules that matter

**1. `--json` for anything you parse.** Response bodies pass through
byte-for-byte: large integers keep their precision, `1.0` stays `1.0`, key order
survives. Never parse the human tables — they are aligned for eyes and their
columns will change.

**2. Exit codes carry the outcome.** Branch on them instead of matching on stderr:

| code | meaning |
|---|---|
| `0` | success |
| `1` | a difference or a failed assertion — the tool worked, the check did not |
| `2` | configuration, usage or authentication; any 4xx except 429 |
| `3` | remote failure: 5xx, 429, timeout, unreachable. **Retryable** |

Only `3` is worth retrying. A `2` will fail again identically.

**3. stdout is the answer, stderr is everything else.** Recaps, progress,
warnings and notes go to stderr. `agent chat` puts the reply on stdout and the
reasoning, tool calls and step markers on stderr, so `agent chat … | tee` captures
the answer alone.

**4. A write needs an explicit workspace; a read does not.** Pass `--org <slug>`
and `--workspace <slug>`, or select a context. A read without one falls back to
the organisation's default workspace and says so on stderr. Workspaces are
addressed by **slug**, never by id.

**5. Rehearse before writing.** Every mutation prints a recap and then requires
confirmation. In automation you have three options, in increasing order of
commitment:

```bash
polyant-cli --dry-run agent update acme --model gpt-4.1   # recap only, sends nothing
polyant-cli --yes     agent update acme --model gpt-4.1   # accept the recap
polyant-cli --yes --confirm acme agent delete acme        # destructive: name it twice
```

`--dry-run` is the cheap way to check you have the arguments right. Destructive
actions — `agent delete`, `channels remove`, `channels whatsapp rotate`,
`hooks remove`, `secrets unset`, `events rotate`, `mcp remove`, `memory remove`,
`memory clear`, `optouts opt-in`, `workspace delete`, `role delete`,
`member remove`, `dev token revoke`, and any non-GET `api` DELETE — additionally require
`--confirm <name>` matching the thing being destroyed.

## Before the first command

The CLI needs a target and a management key. `polyant.yaml` declares the target
and the **name** of the environment variable holding the key; the value only ever
comes from the environment.

```bash
polyant-cli config doctor      # is the config valid, is the key variable set?
polyant-cli whoami             # does the instance answer, what may this key do?
```

If `doctor` reports a key variable as `unset — is it exported?`, that is the usual
failure: `VAR=value` without `export` is a shell variable a child process never
sees. There is no `--key` flag, deliberately: argv is visible in `ps` and lands in
shell history.

`whoami` exits `0` even against an unreachable instance, because reporting that is
its job. Use `monitor status` when you need a gate that fails.

## Where to start

| goal | command |
|---|---|
| what exists | `agent list`, `workspace list`, `org list` |
| one agent in detail | `agent show <slug>` — reports the workspace it really lives in |
| is it healthy | `monitor status` — exits non-zero when a probe fails |
| what happened | `monitor events --limit 50`, `agent logs <slug>` |
| watch it live | `monitor events --follow [--instance <slug>] [--max <n>]` |
| cost and latency | `analytics overview`, `analytics agent <slug>`, `analytics org` |
| try an agent | `agent chat <slug> --message "…" [--expect "…"]` |
| what an agent knows | `agent knowledge list <slug>`, `agent skills show <slug>`, `agent memory list <slug>` |
| tools from elsewhere | `agent mcp show <slug>`, `agent mcp test <slug> --file -` |
| is it exposed to other agents | `agent a2a show <slug>` |
| who asked to be left alone | `agent optouts list <slug>` |
| what governs an agent | `agent governance show <slug>`, `governance policy list` |
| move an agent between instances | `agent export <slug>` → `agent import --file -` |
| who may do what | `role list`, `workspace bindings`, `apikey list` |
| run your local tools against a remote agent | `dev token issue <slug>` → `dev init` → `dev connect <slug> --watch` |
| anything not covered | `api <METHOD> <path>` |

`--follow` has no deadline: bound it with `--max <n>` or you will wait forever.
`dev connect` never returns at all — it holds a session open until interrupted,
and exits `0` when you interrupt it.

`agent chat --expect <text>` exits `1` when the reply does not contain that text,
which makes a scenario check a one-liner.

## Secrets and payloads

Anything sensitive is read from a file or stdin, never from a flag:

```bash
printf %s "$OPENAI_KEY" | polyant-cli agent secrets set acme --key openai_api_key --file - --yes
```

That holds for `agent secrets set`, `org secrets set`, `agent skills env set`,
`channels set`, `mcp set|test`, `memory add`, `hooks add|update`, `prompt set`,
`dev connect --token-file` (whose token otherwise comes from the environment) and
`api --data`. Every structured
payload — a hook, a channel, a scheduled task, a retention policy, a governance
assignment, an import bundle — arrives the same way, as `--file <path|->`. Recaps report a payload's **length and source**,
never its content. `secrets show` and `channels show` report key *names* and
whether they are configured — the engine never serves a stored value and neither
does the CLI.

## The escape hatch

`api` forwards any request with the target and auth resolved:

```bash
polyant-cli api GET /api/instances
polyant-cli api PUT /api/instances/acme/secrets --data - --yes
```

Paths start with `/`, and not everything is under `/api`: `/health`, `/v1`,
`/memories`, `/a2a`, `/channels/http`, `/webhooks` and `/oauth` are top level. Both
directions are byte-for-byte, so it is the right tool for a route with no product
command yet — and the wrong one when a product command exists, because the
product command validates arguments locally and names what it is about to change.

## Two things not to do

**Do not treat a `2` as transient.** Retrying a usage or permission error just
repeats it. Read the message: it names the flag, the missing scope component, or
the permission.

**Do not confuse `--dry-run` with an engine dry run.** `--dry-run` is the CLI's:
it prints the recap and sends nothing. `agent retention run --count-only` is the
engine's: it really calls the engine, which reports what it *would* delete. Only
the second one tells you anything about the data.

**Do not reach for `--yes` to get past a refusal you have not read.** A refusal on
a production target, or a missing `--confirm`, is the one place where the tool is
deliberately in your way. `--dry-run` first, read the recap, then commit.
