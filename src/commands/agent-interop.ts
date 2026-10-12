// SPDX-License-Identifier: Apache-2.0
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { call, expectArray, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { ResolvedScope } from "../runtime/scope.js";
import type { Node } from "../runtime/tree.js";
import { agentPath, preflight, reportWrite, requireSecond, requireSlug } from "../runtime/workspace.js";
import { parseObject } from "./governance.js";

/**
 * The two protocols an agent speaks to the world outside this deployment: MCP
 * outbound (the agent equips tools from someone else's server) and A2A inbound
 * (someone else's agent drives this one). Both arrived in 1.1.0.
 *
 * They share a file because they share the trap: each one moves a credential or
 * an exposure decision across a trust boundary, so both recap what they are
 * about to expose before they do it — a `set` names the URL it will dial and
 * the config KEY names it will store, never a value, and `a2a enable` says out
 * loud when the agent it is exposing has authentication switched off.
 */

/** The engine's `MCP_AUTH_MODES`, restated so a typo fails locally with the list. */
const MCP_AUTH_MODES = ["none", "static", "oauth"] as const;

interface McpServerRow {
  slug: string;
  name: string;
  url: string;
  authMode: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

function requireFile(options: readonly string[], action: string): string {
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError(`polyant-cli agent ${action} needs --file <path> (or --file - for stdin).`);
  return file;
}

async function readPayloadObject(deps: ServiceDependencies, file: string): Promise<Record<string, unknown>> {
  return parseObject(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);
}

/**
 * The engine requires name, url, authMode and config together — a PUT is a
 * replacement, not a patch — so an incomplete payload is refused here rather
 * than sent to be refused there: the local message names the missing field, and
 * a 400 on a route that carries a token is a worse place to learn about a typo.
 */
function readServerDefinition(body: Record<string, unknown>, source: string): {
  name: string;
  url: string;
  authMode: string;
  config: Record<string, unknown>;
} {
  const name = body.name;
  const url = body.url;
  const authMode = body.authMode;
  const config = body.config ?? {};
  if (typeof name !== "string" || name.length === 0) throw new ConfigError(`${source} needs a "name".`);
  if (typeof url !== "string" || url.length === 0) throw new ConfigError(`${source} needs a "url".`);
  if (typeof authMode !== "string" || !(MCP_AUTH_MODES as readonly string[]).includes(authMode)) {
    throw new ConfigError(`${source}: authMode must be one of ${MCP_AUTH_MODES.join(", ")}.`);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new ConfigError(`${source}: "config" must be a JSON object.`);
  }
  return { name, url, authMode, config: config as Record<string, unknown> };
}

/** Config key names, the same disclosure rule `channels show` follows. */
function configKeys(config: Record<string, unknown> | undefined): string {
  return Object.keys(config ?? {}).sort().join(", ") || "-";
}

async function mcpShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "mcp show");
  assertKnown(args.slice(1), {}, "agent mcp show option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/mcp-servers");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const servers = expectArray<McpServerRow>(res.body, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["SERVER", "NAME", "URL", "AUTH", "ENABLED", "CONFIG KEYS"],
      rows: servers.map((server) => [
        text(server.slug),
        text(server.name),
        text(server.url),
        text(server.authMode),
        server.enabled ? "yes" : "no",
        configKeys(server.config),
      ]),
      emptyMessage: `Agent ${slug} equips no MCP servers.`,
    })}\n`,
  );
}

async function mcpSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "mcp set");
  const server = requireSecond(args, "mcp set", "server slug");
  const options = args.slice(2);
  assertKnown(options, { value: ["--file", "--confirm"], boolean: ["--disable"] }, "agent mcp set option");
  const file = requireFile(options, "mcp set");
  const definition = readServerDefinition(await readPayloadObject(deps, file), file === "-" ? "The stdin payload" : file);
  const enabled = !options.includes("--disable");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Set MCP server ${server} on ${slug}`,
    changes: [
      `Dial ${definition.url} as "${definition.name}".`,
      `Authenticate with mode ${definition.authMode}.`,
      `Store config keys: ${configKeys(definition.config)}.`,
      // A re-submitted "••••" is restored from the stored value by the engine,
      // so "show, edit, set" does not silently blank a token — but only for the
      // keys the operator left masked.
      `${enabled ? "Equip" : "Do not equip"} its tools on the agent's next turn.`,
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "PUT",
    path: agentPath(slug, `/mcp-servers/${encodeURIComponent(server)}`),
    body: { ...definition, enabled },
  });
  reportWrite(deps, context, res, `Set MCP server ${server} on ${slug}.`);
}

async function mcpRemove(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "mcp remove");
  const server = requireSecond(args, "mcp remove", "server slug");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent mcp remove option");
  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Remove MCP server ${server} from ${slug}`,
    changes: [`Delete the stored configuration, including its credential.`, "The agent loses that server's tools on its next turn."],
    destructive: { confirm: server },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "DELETE",
    path: agentPath(slug, `/mcp-servers/${encodeURIComponent(server)}`),
  });
  reportWrite(deps, context, res, `Removed MCP server ${server} from ${slug}.`);
}

/**
 * A probe, not a write: it persists nothing, so it asks for no confirmation.
 * It does open a connection to the URL, and the engine gates it on
 * `channel:write` for that reason.
 */
async function mcpTest(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "mcp test");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--server"], boolean: ["--disable"] }, "agent mcp test option");
  const file = requireFile(options, "mcp test");
  const definition = readServerDefinition(await readPayloadObject(deps, file), file === "-" ? "The stdin payload" : file);
  // Naming a saved server lets the engine restore the "••••" fields from what
  // it already holds, so an edited server can be tested without re-typing its
  // token. Without it a masked payload probes the server with no credential.
  const server = takeValue(options, "--server");

  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    method: "POST",
    path: agentPath(slug, "/mcp-servers/test"),
    body: { ...(server === undefined ? {} : { slug: server }), ...definition, enabled: !options.includes("--disable") },
  });
  writeRawResponse(deps.io, res.raw);
}

// --- a2a ---------------------------------------------------------------------

interface AgentA2aState {
  slug?: string;
  a2aEnabled?: boolean;
  authEnabled?: boolean;
}

function a2aCardPath(slug: string): string {
  return `/a2a/${encodeURIComponent(slug)}/.well-known/agent-card.json`;
}

async function readA2aState(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  slug: string,
): Promise<AgentA2aState> {
  const res = await call(deps, scope, { path: agentPath(slug) });
  const instance = (res.body as { instance?: AgentA2aState } | null)?.instance;
  if (instance === undefined) throw new ConfigError(`GET ${agentPath(slug)} did not return an instance.`);
  return instance;
}

async function a2aShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "a2a show");
  assertKnown(args.slice(1), {}, "agent a2a show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: agentPath(slug) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const instance = (res.body as { instance?: AgentA2aState } | null)?.instance;
  if (instance === undefined) throw new ConfigError(`GET ${agentPath(slug)} did not return an instance.`);
  const base = scope.target.baseUrl;
  deps.io.stdout(
    `${[
      `a2aEnabled:  ${instance.a2aEnabled === true ? "yes" : "no"}`,
      `authEnabled: ${instance.authEnabled === true ? "yes" : "no"}`,
      `agent card:  ${base}${a2aCardPath(slug)}`,
      `json-rpc:    ${base}/a2a/${encodeURIComponent(slug)}/jsonrpc`,
    ].join("\n")}\n`,
  );
  if (instance.a2aEnabled === true && instance.authEnabled !== true) {
    deps.io.stderr(`warning: ${slug} is exposed over A2A and authEnabled is false — the JSON-RPC endpoint accepts anyone.\n`);
  }
}

/**
 * The exposure switch, deliberately its own command rather than a flag on
 * `agent update`: turning it on publishes an unauthenticated agent card and
 * opens a JSON-RPC endpoint whose only gate is the agent's own auth switch, and
 * that deserves a recap of its own.
 */
function a2aToggle(enable: boolean) {
  return async function toggle(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
    const action = enable ? "a2a enable" : "a2a disable";
    const slug = requireSlug(args, action);
    const options = args.slice(1);
    assertKnown(options, { value: ["--confirm"] }, `agent ${action} option`);

    const scope = await scopeFor(deps, context);
    const current = await readA2aState(deps, scope, slug);
    if (enable && current.authEnabled !== true) {
      deps.io.stderr(
        `warning: ${slug} has authEnabled is false — once A2A is on, its JSON-RPC endpoint answers any caller that can reach it.\n`,
      );
    }
    const changes = current.a2aEnabled === enable
      ? [`Leave a2aEnabled unchanged at ${enable}.`]
      : enable
        ? [
            "Set a2aEnabled to true.",
            `Publish an unauthenticated agent card at ${scope.target.baseUrl}${a2aCardPath(slug)}.`,
            "Open the JSON-RPC endpoint, gated only by the agent's own authEnabled.",
          ]
        : ["Set a2aEnabled to false.", "The agent card and the JSON-RPC endpoint answer 404 again."];
    if (!(await preflight(deps, scope, context, options, { title: `${enable ? "Expose" : "Withdraw"} ${slug} over A2A`, changes }))) return;

    const res = await call(deps, scope, { method: "PATCH", path: agentPath(slug), body: { a2aEnabled: enable } });
    reportWrite(deps, context, res, `${enable ? "Exposed" : "Withdrew"} ${slug} over A2A.`);
  };
}

/**
 * Fetched through the CLI's own target rather than with curl, so it answers for
 * the instance the operator is addressing. The route is `@Public()`: it needs no
 * key, and it 404s when A2A is off, which is also how it refuses to confirm that
 * an agent exists.
 */
async function a2aCard(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "a2a card");
  assertKnown(args.slice(1), {}, "agent a2a card option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: a2aCardPath(slug) });
  writeRawResponse(deps.io, res.raw);
}

export const AGENT_INTEROP_EXTRAS: Record<string, Node> = {
  mcp: {
    show: {
      summary: "list the MCP servers an agent equips tools from",
      usage: `Usage: polyant-cli agent mcp show <slug>

Config KEY names only: the engine masks a stored credential as "••••" and the
CLI does not print even that. Use \`--json\` for the engine's own response.`,
      action: mcpShow,
    },
    set: {
      summary: "add or replace one MCP server from a JSON file or stdin",
      usage: `Usage: polyant-cli agent mcp set <slug> <server> --file <path|-> [--disable]

The payload needs "name", "url", "authMode" (none, static or oauth) and
"config"; the shape of "config" follows the auth mode:

  none    { "allowList": ["tool"] }                       (allowList optional throughout)
  static  { "auth": { "type": "bearer", "token": "…" } }
          { "auth": { "type": "header", "headerName": "X-Key", "token": "…" } }
  oauth   { "scopes": [...], "staticClient": { "clientId": "…" } }

A PUT REPLACES the server: what the payload omits is not kept. A credential
re-submitted as "••••" is the one exception — the engine restores it from what
it already holds, so \`show --json\` can be edited and sent back.`,
      action: mcpSet,
      mutates: true,
    },
    remove: {
      summary: "delete one MCP server and its stored credential",
      usage: "Usage: polyant-cli agent mcp remove <slug> <server> --yes --confirm <server>",
      action: mcpRemove,
      mutates: true,
    },
    test: {
      summary: "dial a candidate MCP server and report the tools it offers",
      usage: `Usage: polyant-cli agent mcp test <slug> --file <path|-> [--server <server>] [--disable]

Persists nothing, so it needs no confirmation — but it does open a connection
to the URL, which is why the engine gates it on channel:write.

--server names an already-saved server, which lets the engine restore its
masked ("••••") credential fields; without it a masked payload is dialled with
no credential at all.`,
      action: mcpTest,
    },
  },
  a2a: {
    show: {
      summary: "report whether an agent is exposed over A2A, and at which URLs",
      usage: "Usage: polyant-cli agent a2a show <slug>",
      action: a2aShow,
    },
    enable: {
      summary: "expose an agent over the Agent2Agent protocol",
      usage: `Usage: polyant-cli agent a2a enable <slug> --yes

The agent card is served unauthenticated whenever this is on. The JSON-RPC
endpoint is gated by the agent's OWN authEnabled switch and nothing else, so an
agent with authentication off becomes an open LLM endpoint.`,
      action: a2aToggle(true),
      mutates: true,
    },
    disable: {
      summary: "stop exposing an agent over the Agent2Agent protocol",
      usage: "Usage: polyant-cli agent a2a disable <slug> --yes",
      action: a2aToggle(false),
      mutates: true,
    },
    card: {
      summary: "print the agent card this deployment publishes",
      usage: `Usage: polyant-cli agent a2a card <slug>

Reads the public discovery route. A 404 means A2A is off for that agent — or
that the agent does not exist; the route deliberately does not distinguish.`,
      action: a2aCard,
    },
  },
};
