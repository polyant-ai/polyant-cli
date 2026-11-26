---
name: local-plugin-marketplace
description: Use when a developer wants their own Polyant plugin installed in an Organization from their machine — building it with `polyant-cli marketplace serve`, exposing it with ngrok, registering it as an unsigned Organization marketplace, installing it, and shipping each change as a new version. Also use when such an install fails or a new version does not appear.
---

# Serving your plugins as a local marketplace

`polyant-cli marketplace serve` turns plugin projects on this machine into a
marketplace the engine can install from: it bundles each project, writes an
unsigned catalogue, and serves it on `http://127.0.0.1:<port>`. The engine then
installs the plugin as a versioned release, checking every artifact digest,
exactly as it does for the official marketplace.

It is for installing a plugin into an Organization: real releases, versions,
the install dialog, workspace assignment. To edit a tool and retry it against
one agent within seconds, use dev mode instead (`dev token issue` →
`dev init` → `dev connect --watch`): it needs no version bump and no install.

## Before you start

- **Engine:** the Enterprise release that ships organization custom
  marketplaces (not yet released at the time of writing). An OSS engine has no
  marketplaces.
- **Permission:** a Platform Admin must have allowed your Organization to add
  custom, unsigned marketplaces.
- **CLI:** `polyant-cli --version` works (see the README's Install section).
  `marketplace serve` talks to no engine, so it needs no target or key.
- **A plugin project:** a directory with `plugin.json` and `tools/*.tool.ts`
  and/or `hooks/*.hook.ts`, dependencies installed. Copying the dev kit's
  `templates/plugin` and running `npm install` there gives you one.
  `plugin.json` needs a `namespace` (prefix of every tool name, never changes),
  a SemVer `version` and an `engine` range; `displayName` and `description`
  become the catalogue card. A `system` block is refused: a marketplace bundle
  cannot install packages into the engine image.
- **ngrok** (or any HTTPS tunnel) with its auth token configured. Prefer a
  static domain: see "The origin must not change" below.

## Build and serve

```bash
cd my-plugin
polyant-cli marketplace serve            # or: marketplace serve ./a ./b --port 4870
```

It validates each `plugin.json`, bundles the code with its dependencies
inlined, and prints the local URL on stdout. Errors exit `2` before anything is
served and name the fix (`npm install`, a field in `plugin.json`, a version to
bump). Builds go to `.polyant-marketplace/` in the current directory (`--out`
to move it); add it to `.gitignore` and **keep it**: it remembers which digest
each version was served with, and which versions to keep listing.

To require a token on every request, export it and name the variable:
`export MKT_TOKEN=…; polyant-cli marketplace serve --token-env MKT_TOKEN`.
Give the engine the same token when you add the marketplace.

## Expose and register

```bash
ngrok http 4870
```

In Polyant, open Organization settings → Plugins, add a marketplace with the
`https://` origin ngrok printed (the origin only, no path), mark it unsigned,
and add the access token if you set one. The server's
stderr logs one line per request, so `GET /v1/catalog.json 200` there confirms
the engine reached it; `GET /v1/catalog.sig.json 404` is expected and harmless.

If the engine runs on this same machine with
`PLUGIN_MARKETPLACE_ALLOW_LOOPBACK_HTTP=true` (never in production), the origin
`http://localhost:4870` works without a tunnel.

## Install and use

1. In Organization settings → Plugins, install the release from your
   marketplace. The catalogue labels it as coming from an unsigned marketplace.
2. Assign the plugin to a workspace (Workspace plugin settings).
3. Enable its tools or hooks on the agent, and set the secrets the tools
   declare (`polyant-cli agent secrets set <slug> --key <key> --file -`).

Installing alone enables nothing: steps 2 and 3 are separate on purpose.

## Ship a change

Every change is a new version. The engine treats a verified
`(plugin, version)` as immutable and refuses the same version with other bytes,
and `marketplace serve` refuses it first: bump `version` in `plugin.json`, then
restart the command. Earlier versions stay listed, so installed ones keep
appearing. The Organization's catalogue picks the new version up within about
30 seconds of the next visit; then select it on the plugin's page in
Organization settings → Plugins (the engine runs a preflight and refuses a
switch that would silently drop configured capabilities).

Deleting `.polyant-marketplace/` loses that memory. If you do, bump past every
version an engine has already seen.

## The origin must not change

A plugin belongs for good to the marketplace that first served it on that
deployment. A tunnel with a new random URL on every start means registering
another marketplace, and that one cannot serve the plugin you already
installed from the first. Use a static ngrok domain (check
ngrok's docs for the flag your agent version takes), or remove the plugin and
the old marketplace and start over.

## Switching off

Stop the command with Ctrl-C and close the tunnel. The engine keeps its last
verified catalogue, marked stale, and the installed release keeps running on
the engine nodes that already prepared it. An engine node that restarts, or a
new replica, must download the artifact again, and the plugin is unavailable
there until the marketplace is back. A marketplace cannot be removed while an
Organization has one of its plugins installed: uninstall first.

## When it does not work

| symptom | cause |
|---|---|
| no request in the server log | wrong origin, tunnel down, or the marketplace was added with a path |
| `401` in the server log | the token set in Polyant differs from `$VAR` |
| catalogue refused as not valid | file a CLI bug with the catalogue; the CLI checks the format before serving |
| a new version never appears | the old version was rebuilt without a bump (the CLI refuses that), or the page was read less than 30 seconds ago |
| install refused for the digest | the output directory was deleted and a version an engine already verified was rebuilt; bump the version |
| marketplace never read at all | unsigned marketplaces are switched off on this deployment, or your Organization lacks the grant: ask a Platform Admin |
