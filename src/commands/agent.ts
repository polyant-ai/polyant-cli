// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { ApiResponse } from "../api/client.js";
import type {
  AgentDetail,
  AgentDetailResponse,
  ChannelsResponse,
  ConversationsResponse,
  HooksResponse,
  ListAgentsResponse,
  MessageListResponse,
  MessageStep,
  PromptsResponse,
  SecretsResponse,
  ToolsResponse,
} from "../api/types.js";
import type { Command, CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writeCompositeJson, writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import {
  call,
  cappedTotal,
  expectArray,
  maybe,
  positiveInteger,
  processServiceDependencies,
  scopeFor,
  text,
  wantsJson,
  type ServiceDependencies,
} from "../runtime/service.js";
import { buildNode, type Node } from "../runtime/tree.js";
import { preflight, reportWrite, requireSlug } from "../runtime/workspace.js";
import type { ResolvedScope } from "../runtime/scope.js";
import { AGENT_FAMILY_EXTRAS } from "./agent-ops.js";
import { AGENT_DATA_EXTRAS } from "./agent-data.js";
import { AGENT_INTEROP_EXTRAS } from "./agent-interop.js";
import { chat, CHAT_USAGE } from "./agent-chat.js";
import { createMonitorCommand } from "./monitor.js";

/** Kept as a name of its own so the agent tests read as agent tests. */
export type AgentCommandDependencies = ServiceDependencies;

// --- reads -----------------------------------------------------------------

async function list(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  assertKnown(args, {}, "agent list option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: "/api/instances" });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const instances = expectArray<AgentDetail>((res.body as Partial<ListAgentsResponse> | null)?.instances, "GET /api/instances");
  deps.io.stdout(
    `${renderTable({
      headers: ["SLUG", "STATUS", "PROVIDER", "MODEL", "UPDATED"],
      rows: instances.map((agent) => [agent.slug, text(agent.status), text(agent.provider), text(agent.model), text(agent.updatedAt)]),
      emptyMessage: "No agents in this workspace.",
    })}\n`,
  );
}

async function show(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "show");
  assertKnown(args.slice(1), {}, "agent show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}` });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const agent = (res.body as Partial<AgentDetailResponse> | null)?.instance;
  if (agent === undefined) throw new ConfigError(`GET /api/instances/${slug} did not return an instance.`);
  writePrettyResource(deps.io, [
    { label: "slug", value: agent.slug },
    { label: "workspace", value: text(agent.workspaceSlug) },
    { label: "name", value: text(agent.name) },
    { label: "description", value: text(agent.description) },
    { label: "status", value: text(agent.status) },
    { label: "provider", value: text(agent.provider) },
    { label: "model", value: text(agent.model) },
    { label: "authEnabled", value: text(agent.authEnabled) },
    { label: "a2aEnabled", value: agent.a2aEnabled === true ? "true" : "false" },
    { label: "memoryEnabled", value: text(agent.memoryEnabled) },
    // Only meaningful while memory is on, but printed regardless: a scope that
    // disappeared when memory was off would look like an engine that has none.
    { label: "memoryScope", value: text(agent.memoryScope) },
    { label: "knowledgeEnabled", value: text(agent.knowledgeEnabled) },
    { label: "updatedAt", value: text(agent.updatedAt) },
  ]);
}

// --- agent lifecycle -------------------------------------------------------

const CREATE_FLAGS = { value: ["--name", "--description", "--provider", "--model"] } as const;

async function create(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "create");
  const options = args.slice(1);
  assertKnown(options, CREATE_FLAGS, "agent create option");
  const name = takeValue(options, "--name");
  if (name === undefined) throw new ConfigError("polyant-cli agent create needs --name <name>.");
  const body = {
    slug,
    name,
    ...optional(options, "--description", "description"),
    ...optional(options, "--provider", "provider"),
    ...optional(options, "--model", "model"),
  };

  const scope = await scopeFor(deps, context);
  const changes = Object.entries(body)
    .filter(([field]) => field !== "slug")
    .map(([field, value]) => `Set ${field} to ${JSON.stringify(value)}.`);
  if (!(await preflight(deps, scope, context, options, { title: `Create agent ${slug}`, changes }))) return;

  const res = await call(deps, scope, { method: "POST", path: "/api/instances", body });
  reportWrite(deps, context, res, `Created agent ${slug}.`);
}

function optional(options: readonly string[], flag: string, field: string): Record<string, string> {
  const value = takeValue(options, flag);
  return value === undefined ? {} : { [field]: value };
}

const UPDATE_FLAGS = {
  value: ["--name", "--description", "--provider", "--model", "--status", "--stt-provider", "--memory-scope", "--confirm"],
} as const;

/**
 * The engine's own union. "disabled" is the one that matters: an unrecognised
 * value used to fall back to Whisper silently, so an operator who wanted voice
 * messages off had no way to say so.
 */
const STT_PROVIDERS = ["openai", "aws", "deepgram", "disabled"] as const;

/**
 * What a caller may SET, which is narrower than what the engine stores.
 * `principal` is a third stored value, reserved for identity work that has not
 * landed; the engine refuses it on the write path and resolves it as
 * `conversation` on the read path, so offering it here would offer a no-op.
 */
const MEMORY_SCOPES = ["agent", "conversation"] as const;

function memoryScope(options: readonly string[]): Record<string, string> {
  const value = takeValue(options, "--memory-scope");
  if (value === undefined) return {};
  if (!(MEMORY_SCOPES as readonly string[]).includes(value)) {
    throw new ConfigError(`--memory-scope must be one of ${MEMORY_SCOPES.join(", ")}.`);
  }
  return { memoryScope: value };
}

function sttProvider(options: readonly string[]): Record<string, string> {
  const value = takeValue(options, "--stt-provider");
  if (value === undefined) return {};
  if (!(STT_PROVIDERS as readonly string[]).includes(value)) {
    throw new ConfigError(`--stt-provider must be one of ${STT_PROVIDERS.join(", ")}.`);
  }
  return { sttProvider: value };
}

async function update(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "update");
  const options = args.slice(1);
  assertKnown(options, UPDATE_FLAGS, "agent update option");
  const body: Record<string, string> = {
    ...optional(options, "--name", "name"),
    ...optional(options, "--description", "description"),
    ...optional(options, "--provider", "provider"),
    ...optional(options, "--model", "model"),
    ...optional(options, "--status", "status"),
    ...sttProvider(options),
    ...memoryScope(options),
  };
  if (Object.keys(body).length === 0) throw new ConfigError("polyant-cli agent update needs at least one field to change.");

  const scope = await scopeFor(deps, context);
  // Read the current state first: a recap that cannot name the previous value
  // hides the case where the flag changes nothing at all.
  const before = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}` });
  const current = (before.body as Partial<AgentDetailResponse> | null)?.instance;
  if (current === undefined) throw new ConfigError(`GET /api/instances/${slug} did not return an instance.`);

  const changes = Object.entries(body).map(([field, value]) => {
    const previous = (current as unknown as Record<string, unknown>)[field];
    return String(previous) === value
      ? `Leave ${field} unchanged at ${JSON.stringify(value)}.`
      : `Change ${field} from ${JSON.stringify(text(previous))} to ${JSON.stringify(value)}.`;
  });
  if (!(await preflight(deps, scope, context, options, { title: `Update agent ${slug}`, changes }))) return;

  const res = await call(deps, scope, { method: "PATCH", path: `/api/instances/${encodeURIComponent(slug)}`, body });
  reportWrite(deps, context, res, `Updated agent ${slug}.`);
}

async function remove(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "delete");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "agent delete option");
  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Delete agent ${slug}`,
    changes: [
      `Delete agent ${slug} and its conversations, messages, memories, knowledge base and scheduled tasks.`,
      "Prompts, tools, channels, secrets and webhooks are removed with it.",
    ],
    destructive: { confirm: slug },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: `/api/instances/${encodeURIComponent(slug)}` });
  reportWrite(deps, context, res, `Deleted agent ${slug}.`);
}

// --- prompts ---------------------------------------------------------------

async function promptShow(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "prompt show");
  const options = args.slice(1);
  assertKnown(options, { value: ["--section"] }, "agent prompt show option");
  const section = takeValue(options, "--section");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/prompts` });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const prompts = expectArray<PromptsResponse["prompts"][number]>(
    (res.body as Partial<PromptsResponse> | null)?.prompts,
    `GET /api/instances/${slug}/prompts`,
  );
  if (section !== undefined) {
    const found = prompts.find((prompt) => prompt.key === section);
    if (found === undefined) {
      throw new ConfigError(`Agent ${slug} has no prompt section "${section}". Declared: ${prompts.map((p) => p.key).join(", ")}.`);
    }
    return deps.io.stdout(found.content.endsWith("\n") ? found.content : `${found.content}\n`);
  }
  deps.io.stdout(
    `${renderTable({
      headers: ["KEY", "TITLE", "CHARS"],
      rows: prompts.map((prompt) => [prompt.key, text(prompt.title), String(prompt.content.length)]),
      emptyMessage: `Agent ${slug} has no prompt sections.`,
    })}\n`,
  );
}

async function promptSet(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "prompt set");
  const options = args.slice(1);
  assertKnown(options, { value: ["--section", "--file", "--confirm"] }, "agent prompt set option");
  const section = takeValue(options, "--section");
  const file = takeValue(options, "--file");
  if (section === undefined) throw new ConfigError("polyant-cli agent prompt set needs --section <key>.");
  if (file === undefined) throw new ConfigError('polyant-cli agent prompt set needs --file <path> (or --file - for stdin).');

  const content = await deps.readPayload(file);
  const scope = await scopeFor(deps, context);
  const before = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/prompts` });
  const existing = expectArray<PromptsResponse["prompts"][number]>(
    (before.body as Partial<PromptsResponse> | null)?.prompts,
    `GET /api/instances/${slug}/prompts`,
  ).find((prompt) => prompt.key === section);

  const changes =
    existing === undefined
      ? [`Add prompt section ${section} with ${content.length} characters.`]
      : existing.content === content
        ? [`Leave prompt section ${section} unchanged at ${content.length} characters.`]
        : [`Replace prompt section ${section}: ${existing.content.length} characters become ${content.length}.`];
  if (!(await preflight(deps, scope, context, options, { title: `Set prompt section ${section} on ${slug}`, changes }))) return;

  const res = await call(deps, scope, {
    method: "PATCH",
    path: `/api/instances/${encodeURIComponent(slug)}/prompts`,
    body: { sections: [{ key: section, content }] },
  });
  reportWrite(deps, context, res, `Updated prompt section ${section} on ${slug}.`);
}

// --- tools -----------------------------------------------------------------

async function toolsShow(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "tools show");
  assertKnown(args.slice(1), { boolean: ["--enabled-only"] }, "agent tools show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/tools` });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const all = expectArray<ToolsResponse["tools"][number]>(
    (res.body as Partial<ToolsResponse> | null)?.tools,
    `GET /api/instances/${slug}/tools`,
  );
  const tools = args.includes("--enabled-only") ? all.filter((tool) => tool.enabled) : all;
  deps.io.stdout(
    `${renderTable({
      headers: ["NAME", "ENABLED", "CATEGORY", "SOURCE"],
      rows: tools.map((tool) => [tool.name, tool.enabled ? "yes" : "no", text(tool.category), text(tool.source)]),
      emptyMessage: `Agent ${slug} has no tools to show.`,
    })}\n`,
  );
}

function parseNameList(value: string, flag: string): string[] {
  const names = value.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) throw new ConfigError(`${flag} needs at least one name.`);
  return names;
}

async function toolsSet(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "tools set");
  const options = args.slice(1);
  assertKnown(options, { value: ["--enable", "--confirm"], boolean: ["--none"] }, "agent tools set option");
  const enable = takeValue(options, "--enable");
  const none = options.includes("--none");
  if (enable === undefined && !none) throw new ConfigError("polyant-cli agent tools set needs --enable <names> or --none.");
  if (enable !== undefined && none) throw new ConfigError("Use only one of --enable or --none.");
  // The engine replaces the whole selection, so the flag has to be read as the
  // complete desired set rather than an increment.
  const desired = enable === undefined ? [] : parseNameList(enable, "--enable");

  const scope = await scopeFor(deps, context);
  const before = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/tools` });
  const all = expectArray<ToolsResponse["tools"][number]>(
    (before.body as Partial<ToolsResponse> | null)?.tools,
    `GET /api/instances/${slug}/tools`,
  );
  const known = new Set(all.map((tool) => tool.name));
  const unknown = desired.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new ConfigError(`Agent ${slug} has no tool named: ${unknown.join(", ")}.`);

  const enabledNow = new Set(all.filter((tool) => tool.enabled).map((tool) => tool.name));
  const added = desired.filter((name) => !enabledNow.has(name));
  const removed = [...enabledNow].filter((name) => !desired.includes(name));
  const unchanged = desired.filter((name) => enabledNow.has(name));
  const changes = [
    added.length === 0 ? "Enable no additional tools." : `Enable: ${added.join(", ")}.`,
    removed.length === 0 ? "Disable no tools." : `Disable: ${removed.join(", ")}.`,
    `Leave enabled: ${unchanged.length === 0 ? "(none)" : unchanged.join(", ")}.`,
  ];
  if (!(await preflight(deps, scope, context, options, { title: `Set tools on ${slug}`, changes }))) return;

  const res = await call(deps, scope, {
    method: "PATCH",
    path: `/api/instances/${encodeURIComponent(slug)}/tools`,
    body: { enabled: desired },
  });
  reportWrite(deps, context, res, `Updated tools on ${slug}.`);
}

// --- channels --------------------------------------------------------------

async function channelsShow(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "channels show");
  assertKnown(args.slice(1), {}, "agent channels show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/channels` });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const channels = expectArray<ChannelsResponse["channels"][number]>(
    (res.body as Partial<ChannelsResponse> | null)?.channels,
    `GET /api/instances/${slug}/channels`,
  );
  // Key names only. The engine masks secrets as "••••…", but printing a masked
  // value still discloses which fields are populated in a form that gets pasted
  // into tickets; the key list answers the operator's question without that.
  deps.io.stdout(
    `${renderTable({
      headers: ["TYPE", "ENABLED", "CONFIG KEYS", "AUTO-DISABLED"],
      rows: channels.map((channel) => [
        channel.channelType,
        channel.enabled ? "yes" : "no",
        // A config that failed to decrypt has no readable keys, and listing "-"
        // for it would report a rotated ENCRYPTION_KEY as an empty channel —
        // the one reading an operator must not get wrong here.
        channel.configReadable === false
          ? "(unreadable)"
          : Object.keys(channel.config ?? {}).sort().join(", ") || "-",
        text(channel.disabledReason),
      ]),
      emptyMessage: `Agent ${slug} has no channels configured.`,
    })}\n`,
  );
}

function requireType(args: readonly string[], action: string): string {
  const type = args[1];
  if (type === undefined || type.startsWith("--")) throw new ConfigError(`polyant-cli agent ${action} needs a channel type.`);
  return type;
}

function parseJsonPayload(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${source} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function channelsSet(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "channels set");
  const type = requireType(args, "channels set");
  const options = args.slice(2);
  assertKnown(options, { value: ["--file", "--confirm"], boolean: ["--disable"] }, "agent channels set option");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError('polyant-cli agent channels set needs --file <path> (or --file - for stdin).');
  const enabled = !options.includes("--disable");
  const config = parseJsonPayload(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);

  const scope = await scopeFor(deps, context);
  const before = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/channels` });
  const existing = expectArray<ChannelsResponse["channels"][number]>(
    (before.body as Partial<ChannelsResponse> | null)?.channels,
    `GET /api/instances/${slug}/channels`,
  ).find((channel) => channel.channelType === type);

  const supplied = Object.keys(config).sort();
  const previous = Object.keys(existing?.config ?? {}).sort();
  const changes = [
    existing === undefined ? `Add channel ${type}.` : `Update channel ${type}.`,
    `Set config keys: ${supplied.join(", ") || "(none)"}.`,
    ...(previous.filter((key) => !supplied.includes(key)).length === 0
      ? []
      : [`Keep unlisted stored keys: ${previous.filter((key) => !supplied.includes(key)).join(", ")}.`]),
    `${enabled ? "Start" : "Stop"} the ${type} adapter.`,
  ];
  if (!(await preflight(deps, scope, context, options, { title: `Set channel ${type} on ${slug}`, changes }))) return;

  const res = await call(deps, scope, {
    method: "PUT",
    path: `/api/instances/${encodeURIComponent(slug)}/channels/${encodeURIComponent(type)}`,
    body: { config, enabled },
  });
  reportWrite(deps, context, res, `Updated channel ${type} on ${slug}.`);
}

async function channelsRemove(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "channels remove");
  const type = requireType(args, "channels remove");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent channels remove option");
  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Remove channel ${type} from ${slug}`,
    changes: [`Stop the ${type} adapter.`, `Delete the stored ${type} configuration, including its secrets.`],
    destructive: { confirm: type },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "DELETE",
    path: `/api/instances/${encodeURIComponent(slug)}/channels/${encodeURIComponent(type)}`,
  });
  reportWrite(deps, context, res, `Removed channel ${type} from ${slug}.`);
}

// --- whatsapp inbound ------------------------------------------------------

/**
 * A WhatsApp channel authenticating to Twilio with a revocable API Key cannot
 * be verified by Twilio's signature — Twilio signs with the account Auth Token
 * alone — so it receives on a URL carrying a server-generated secret instead.
 * That secret is bearer-equivalent, so `channels show` withholds it and these
 * two routes, both `channel:write`, are the only way to see or replace it.
 *
 * Both answer 404 when the channel is not in API-Key mode, which is the engine
 * saying "there is no such secret here", not "there is no such agent".
 */
function whatsappPath(slug: string, rest: string): string {
  return `/api/instances/${encodeURIComponent(slug)}/channels/whatsapp/${rest}`;
}

async function whatsappUrl(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "channels whatsapp url");
  assertKnown(args.slice(1), {}, "agent channels whatsapp url option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: whatsappPath(slug, "webhook-url") });
  // Printed whole rather than summarised: the URL IS the answer, and it is the
  // one thing the operator has to paste elsewhere verbatim.
  writeRawResponse(deps.io, res.raw);
}

async function whatsappRotate(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "channels whatsapp rotate");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "agent channels whatsapp rotate option");
  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Rotate the WhatsApp inbound secret of ${slug}`,
    changes: [
      "The current inbound URL stops working immediately.",
      "Paste the new URL into the Twilio Console before the next inbound message, or it is lost.",
    ],
    destructive: { confirm: slug },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: whatsappPath(slug, "rotate-webhook-secret") });
  // The response carries the new URL, so it is printed whole even in text mode.
  writeRawResponse(deps.io, res.raw);
}

// --- secrets ---------------------------------------------------------------

function secretsPath(slug: string, key?: string): string {
  const base = `/api/instances/${encodeURIComponent(slug)}/secrets`;
  return key === undefined ? base : `${base}/${encodeURIComponent(key)}`;
}

/**
 * The declared key set, read rather than assumed: it varies per agent with the
 * tools and channels it has, so a hardcoded list would drift and would reject
 * keys the engine accepts.
 */
async function secretsOf(deps: AgentCommandDependencies, scope: ResolvedScope, slug: string): Promise<SecretsResponse["secrets"]> {
  const res = await call(deps, scope, { path: secretsPath(slug) });
  return expectArray<SecretsResponse["secrets"][number]>(
    (res.body as Partial<SecretsResponse> | null)?.secrets,
    `GET ${secretsPath(slug)}`,
  );
}

async function secretsShow(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "secrets show");
  assertKnown(args.slice(1), { boolean: ["--configured-only"] }, "agent secrets show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: secretsPath(slug) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const all = expectArray<SecretsResponse["secrets"][number]>(
    (res.body as Partial<SecretsResponse> | null)?.secrets,
    `GET ${secretsPath(slug)}`,
  );
  const secrets = args.includes("--configured-only") ? all.filter((secret) => secret.configured) : all;
  // Presence only. The engine never serves the value, and this command must never
  // become the place where one is printed.
  deps.io.stdout(
    `${renderTable({
      headers: ["KEY", "CONFIGURED"],
      rows: secrets.map((secret) => [secret.key, secret.configured ? "yes" : "no"]),
      emptyMessage: `Agent ${slug} declares no secrets.`,
    })}\n`,
  );
}

function requireKey(options: readonly string[], action: string): string {
  const key = takeValue(options, "--key");
  if (key === undefined) throw new ConfigError(`polyant-cli agent ${action} needs --key <name>.`);
  return key;
}

function assertDeclared(secrets: readonly SecretsResponse["secrets"][number][], key: string, slug: string): SecretsResponse["secrets"][number] {
  const found = secrets.find((secret) => secret.key === key);
  if (found !== undefined) return found;
  // A typo would otherwise be accepted as a new key by the engine, so the real
  // credential would stay untouched while the command reported success.
  throw new ConfigError(
    `Agent ${slug} declares no secret named ${JSON.stringify(key)}. Declared: ${secrets.map((secret) => secret.key).join(", ")}.`,
  );
}

async function secretsSet(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "secrets set");
  const options = args.slice(1);
  assertKnown(options, { value: ["--key", "--file", "--confirm"] }, "agent secrets set option");
  const key = requireKey(options, "secrets set");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError('polyant-cli agent secrets set needs --file <path> (or --file - for stdin).');

  // Read the value before the recap, but never put it in one: a secret passed as
  // a flag would land in shell history and in `ps`, and printed in a recap it
  // would land on the terminal and in whatever captures it.
  const value = (await deps.readPayload(file)).trim();
  if (value.length === 0) throw new ConfigError(`${file === "-" ? "stdin" : file} contained no value.`);

  const scope = await scopeFor(deps, context);
  const secrets = await secretsOf(deps, scope, slug);
  const existing = assertDeclared(secrets, key, slug);

  const changes = [
    existing.configured ? `Replace the stored ${key}.` : `Set ${key}, which is not configured yet.`,
    `Value: ${value.length} characters from ${file === "-" ? "stdin" : file}, never shown.`,
  ];
  if (!(await preflight(deps, scope, context, options, { title: `Set secret ${key} on ${slug}`, changes }))) return;

  // The engine merges rather than replaces, so sending one key leaves the others
  // configured — verified against a live instance.
  const res = await call(deps, scope, { method: "PUT", path: secretsPath(slug), body: { secrets: [{ key, value }] } });
  reportWrite(deps, context, res, `Set secret ${key} on ${slug}.`);
}

async function secretsUnset(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "secrets unset");
  const options = args.slice(1);
  assertKnown(options, { value: ["--key", "--confirm"] }, "agent secrets unset option");
  const key = requireKey(options, "secrets unset");

  const scope = await scopeFor(deps, context);
  const secrets = await secretsOf(deps, scope, slug);
  const existing = assertDeclared(secrets, key, slug);
  if (!existing.configured) {
    // The engine answers 200 for a key it never held, so without this a mistyped
    // or already-removed key would report success while the real one stayed put.
    throw new ConfigError(`Secret ${key} is not configured on ${slug}; there is nothing to remove.`);
  }

  const plan = {
    title: `Remove secret ${key} from ${slug}`,
    changes: [`Delete the stored ${key}. Anything on ${slug} that needs it stops working until it is set again.`],
    destructive: { confirm: key },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: secretsPath(slug, key) });
  reportWrite(deps, context, res, `Removed secret ${key} from ${slug}.`);
}

// --- hooks -----------------------------------------------------------------

async function hooksShow(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "hooks show");
  assertKnown(args.slice(1), {}, "agent hooks show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/hooks` });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const hooks = expectArray<HooksResponse["hooks"][number]>(
    (res.body as Partial<HooksResponse> | null)?.hooks,
    `GET /api/instances/${slug}/hooks`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "EVENT", "ACTION", "ENABLED", "POS", "TIMEOUT"],
      rows: hooks.map((hook) => [
        hook.id,
        text(hook.event),
        text(hook.actionType),
        hook.enabled ? "yes" : "no",
        text(hook.position),
        text(hook.timeoutMs),
      ]),
      emptyMessage: `Agent ${slug} has no hooks.`,
    })}\n`,
  );
}

async function hooksAdd(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "hooks add");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent hooks add option");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError('polyant-cli agent hooks add needs --file <path> (or --file - for stdin).');
  const body = parseJsonPayload(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);

  const scope = await scopeFor(deps, context);
  const changes = [`Add a hook for event ${JSON.stringify(text(body.event))} with keys: ${Object.keys(body).sort().join(", ")}.`];
  if (!(await preflight(deps, scope, context, options, { title: `Add hook to ${slug}`, changes }))) return;

  const res = await call(deps, scope, { method: "POST", path: `/api/instances/${encodeURIComponent(slug)}/hooks`, body });
  reportWrite(deps, context, res, `Added a hook to ${slug}.`);
}

function requireHookId(args: readonly string[], action: string): string {
  const id = args[1];
  if (id === undefined || id.startsWith("--")) throw new ConfigError(`polyant-cli agent ${action} needs a hook id.`);
  return id;
}

async function hooksUpdate(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "hooks update");
  const id = requireHookId(args, "hooks update");
  const options = args.slice(2);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent hooks update option");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError('polyant-cli agent hooks update needs --file <path> (or --file - for stdin).');
  const body = parseJsonPayload(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);

  const scope = await scopeFor(deps, context);
  const before = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/hooks` });
  const existing = expectArray<HooksResponse["hooks"][number]>(
    (before.body as Partial<HooksResponse> | null)?.hooks,
    `GET /api/instances/${slug}/hooks`,
  ).find((hook) => hook.id === id);
  if (existing === undefined) throw new ConfigError(`Agent ${slug} has no hook ${id}.`);

  const changes = Object.keys(body)
    .sort()
    .map((field) => {
      const previous = (existing as unknown as Record<string, unknown>)[field];
      return `Set ${field} to ${JSON.stringify(body[field])} (was ${JSON.stringify(previous ?? null)}).`;
    });
  if (!(await preflight(deps, scope, context, options, { title: `Update hook ${id} on ${slug}`, changes }))) return;

  const res = await call(deps, scope, {
    method: "PATCH",
    path: `/api/instances/${encodeURIComponent(slug)}/hooks/${encodeURIComponent(id)}`,
    body,
  });
  reportWrite(deps, context, res, `Updated hook ${id} on ${slug}.`);
}

async function hooksRemove(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "hooks remove");
  const id = requireHookId(args, "hooks remove");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent hooks remove option");
  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Remove hook ${id} from ${slug}`,
    changes: [`Delete hook ${id}; the governance rule it implements stops running immediately.`],
    destructive: { confirm: id },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "DELETE",
    path: `/api/instances/${encodeURIComponent(slug)}/hooks/${encodeURIComponent(id)}`,
  });
  reportWrite(deps, context, res, `Removed hook ${id} from ${slug}.`);
}

// --- logs ------------------------------------------------------------------

/**
 * The same query `monitor events` runs, with the instance filter forced to this
 * agent. Delegating rather than re-implementing keeps one transport path, and
 * keeps `--follow` filtered server-side.
 */
async function logs(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "logs");
  await createMonitorCommand(deps).actions.events(args, context, slug);
}

// --- conversations ---------------------------------------------------------

async function conversationsList(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "conversations list");
  const options = args.slice(1);
  assertKnown(options, { value: ["--limit", "--offset", "--search", "--source", "--from", "--to"] }, "agent conversations list option");
  const scope = await scopeFor(deps, context, "read");
  const search = takeValue(options, "--search");
  // The engine spells the window `updatedSince`/`updatedUntil` on this route
  // and `from`/`to` on the audit log. The operator should not have to know
  // that: `--from`/`--to` mean the same thing everywhere in the CLI, and the
  // mapping happens here.
  const from = takeValue(options, "--from");
  const to = takeValue(options, "--to");
  // The engine's search path is FTS-ranked and never time-windowed, so it drops
  // `updatedSince`/`updatedUntil` on the floor. Accepting both would answer a
  // question the operator did not ask, with no sign that half the request was
  // discarded.
  if (search !== undefined && (from !== undefined || to !== undefined)) {
    throw new ConfigError(
      "agent conversations list cannot combine --search with --from/--to: the engine's search is ranked by " +
        "relevance and ignores the time window. Run the search, or the window, but not both.",
    );
  }
  const query = {
    // instanceId carries the agent slug: the engine resolves it through
    // asInstanceSlug, not as a UUID.
    instanceId: slug,
    ...maybe("limit", positiveInteger(takeValue(options, "--limit"), "--limit")),
    ...maybe("offset", takeValue(options, "--offset")),
    ...maybe("search", search),
    ...maybe("source", takeValue(options, "--source")),
    ...maybe("updatedSince", from),
    ...maybe("updatedUntil", to),
  };
  const res = await call(deps, scope, { path: "/api/conversations", query });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const conversations = expectArray<ConversationsResponse["conversations"][number]>(
    (res.body as Partial<ConversationsResponse> | null)?.conversations,
    "GET /api/conversations",
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["CONVERSATION", "CHANNEL", "MESSAGES", "TOKENS", "UPDATED", "TITLE"],
      rows: conversations.map((conversation) => [
        conversation.conversationId,
        text(conversation.channel),
        text(conversation.messageCount),
        text(conversation.totalTokens),
        text(conversation.updatedAt),
        text(conversation.title),
      ]),
      emptyMessage: `Agent ${slug} has no conversations.`,
    })}\n`,
  );
}

async function conversationsShow(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "conversations show");
  const id = args[1];
  if (id === undefined || id.startsWith("--")) throw new ConfigError("polyant-cli agent conversations show needs a conversation id.");
  const options = args.slice(2);
  assertKnown(options, { value: ["--limit"] }, "agent conversations show option");
  const scope = await scopeFor(deps, context, "read");
  const encoded = encodeURIComponent(id);
  const conversation = await call(deps, scope, { path: `/api/conversations/${encoded}`, query: { instanceId: slug } });
  const messages = await call(deps, scope, {
    path: `/api/conversations/${encoded}/messages`,
    query: { instanceId: slug, ...maybe("limit", positiveInteger(takeValue(options, "--limit"), "--limit")) },
  });

  if (wantsJson(context)) {
    return writeCompositeJson(deps.io, { conversation: conversation.raw, messages: messages.raw });
  }

  const detail = (conversation.body as { conversation?: Record<string, unknown> } | null)?.conversation;
  if (detail === undefined) throw new ConfigError(`GET /api/conversations/${id} did not return a conversation.`);
  writePrettyResource(deps.io, [
    { label: "conversationId", value: text(detail.conversationId ?? id) },
    { label: "title", value: text(detail.title) },
    { label: "channel", value: text(detail.channel) },
    { label: "messageCount", value: text(detail.messageCount) },
    { label: "totalTokens", value: text(detail.totalTokens) },
    { label: "totalCost", value: text(detail.totalCost) },
    { label: "updatedAt", value: text(detail.updatedAt) },
  ]);

  const rows = expectArray<Record<string, unknown>>(
    (messages.body as { messages?: unknown } | null)?.messages,
    `GET /api/conversations/${id}/messages`,
  );
  deps.io.stdout(
    `\n${renderTable({
      headers: ["ROLE", "CREATED", "TOOLS", "CONTENT"],
      rows: rows.map((message) => [
        text(message.role),
        text(message.createdAt),
        renderToolCalls(message.steps),
        text(message.content).replaceAll("\n", " "),
      ]),
      emptyMessage: "No messages in this conversation.",
    })}\n`,
  );
}

/**
 * The tool names a turn actually invoked, in step order. They arrive in the same
 * payload as the message, so a text render that dropped them made the operator
 * re-fetch with `--json` and reach for `jq` to answer the first question anyone
 * has about an agent's turn: which tool ran. A call whose result is missing from
 * the same message is marked `?` — that is a turn that ended mid-tool, and it
 * reads as an empty column otherwise.
 *
 * The arguments and the results stay out: they are unbounded JSON, and a table
 * cell is the wrong place for them. `--json` carries them unchanged.
 */
function renderToolCalls(steps: unknown): string {
  if (!Array.isArray(steps)) return "-";
  const names: string[] = [];
  for (const step of steps as MessageStep[]) {
    const answered = new Set((step.toolResults ?? []).map((result) => result.toolCallId));
    for (const call of step.toolCalls ?? []) {
      names.push(answered.has(call.toolCallId) ? call.toolName : `${call.toolName}?`);
    }
  }
  return names.length === 0 ? "-" : names.join(", ");
}

/**
 * Messages across ALL of one agent's conversations, in one call.
 *
 * `agent conversations show` reads a single conversation; this reads the window.
 * The engine requires the agent slug, which is why it is positional here.
 */
async function messages(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "messages");
  const options = args.slice(1);
  assertKnown(
    options,
    { value: ["--conversation", "--role", "--from", "--to", "--limit", "--offset"] },
    "agent messages option",
  );
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    path: "/api/messages",
    query: {
      instanceId: slug,
      ...maybe("conversationId", takeValue(options, "--conversation")),
      ...maybe("role", takeValue(options, "--role")),
      ...maybe("from", takeValue(options, "--from")),
      ...maybe("to", takeValue(options, "--to")),
      ...maybe("limit", positiveInteger(takeValue(options, "--limit"), "--limit")),
      ...maybe("offset", takeValue(options, "--offset")),
    },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = res.body as Partial<MessageListResponse> | null;
  const items = expectArray<MessageListResponse["items"][number]>(body?.items, "GET /api/messages");
  deps.io.stdout(
    `${renderTable({
      headers: ["CREATED", "CONVERSATION", "ROLE", "CONTENT"],
      rows: items.map((item) => [
        text(item.createdAt),
        text(item.conversationId),
        text(item.role),
        text(item.content).replaceAll("\n", " ").slice(0, 80),
      ]),
      emptyMessage: `Agent ${slug} has no messages in this window.`,
    })}\n`,
  );
  deps.io.stderr(`${items.length} of ${cappedTotal(body)} messages. Use --json for the untruncated content.\n`);
}

// --- command tree ----------------------------------------------------------

const LEAVES: Record<string, Node> = {
  list: { summary: "list the agents in the workspace", usage: "Usage: polyant-cli agent list", action: list },
  show: { summary: "show one agent's configuration", usage: "Usage: polyant-cli agent show <slug>", action: show },
  create: {
    summary: "create an agent",
    usage: "Usage: polyant-cli agent create <slug> --name <name> [--description <text>] [--provider <name>] [--model <id>]",
    action: create,
    mutates: true,
  },
  update: {
    summary: "change an agent's name, description, status, provider, model or memory scope",
    usage: `Usage: polyant-cli agent update <slug> [--name <name>] [--description <text>] [--status <status>]
                                 [--provider <name>] [--model <id>] [--stt-provider <p>]
                                 [--memory-scope <agent|conversation>]

--stt-provider is one of openai, aws, deepgram or disabled. "disabled" is a real
setting, not an absent one: the agent then tells a sender that voice messages
are not supported instead of transcribing them.

--memory-scope decides how wide long-term memory reaches: "agent" is one pool
shared by every conversation, "conversation" is a pool per conversation. It does
not migrate what is already stored — memories written under one scope stay under
the key they were written with, so a flip changes what NEW turns can recall.`,
    action: update,
    mutates: true,
  },
  delete: {
    summary: "delete an agent and its operational data",
    usage: "Usage: polyant-cli agent delete <slug> --yes --confirm <slug>",
    action: remove,
    mutates: true,
  },
  prompt: {
    show: {
      summary: "list prompt sections, or print one section's content",
      usage: "Usage: polyant-cli agent prompt show <slug> [--section <key>]",
      action: promptShow,
    },
    set: {
      summary: "replace one prompt section from a file or stdin",
      usage: "Usage: polyant-cli agent prompt set <slug> --section <key> --file <path|->",
      action: promptSet,
      mutates: true,
    },
  },
  tools: {
    show: {
      summary: "list the tools available to an agent",
      usage: "Usage: polyant-cli agent tools show <slug> [--enabled-only]",
      action: toolsShow,
    },
    set: {
      summary: "replace the agent's enabled tool selection",
      usage: "Usage: polyant-cli agent tools set <slug> --enable <name,name> | --none",
      action: toolsSet,
      mutates: true,
    },
  },
  channels: {
    show: {
      summary: "list configured channels, their config key names and any engine-side disable",
      usage: `Usage: polyant-cli agent channels show <slug>

Key names only: the engine masks values, and a masked value still discloses
which fields are populated. CONFIG KEYS reads "(unreadable)" when the stored
config failed to decrypt — a rotated ENCRYPTION_KEY, not an empty channel.
AUTO-DISABLED names why the ENGINE turned the channel off; it stays "-" when a
person did, or when nobody has.`,
      action: channelsShow,
    },
    set: {
      summary: "set one channel's configuration from a file or stdin",
      usage: "Usage: polyant-cli agent channels set <slug> <type> --file <path|-> [--disable]",
      action: channelsSet,
      mutates: true,
    },
    remove: {
      summary: "delete one channel's configuration and secrets",
      usage: "Usage: polyant-cli agent channels remove <slug> <type> --yes --confirm <type>",
      action: channelsRemove,
      mutates: true,
    },
    whatsapp: {
      url: {
        summary: "reveal the inbound webhook URL of an API-Key WhatsApp channel",
        usage: `Usage: polyant-cli agent channels whatsapp url <slug>

The URL carries a server-generated secret and is bearer-equivalent, so it needs
channel:write and \`channels show\` withholds it. A 404 means the channel is not
in Twilio API-Key mode — an Auth Token channel has no such URL.`,
        action: whatsappUrl,
      },
      rotate: {
        summary: "issue a new inbound webhook secret, invalidating the current URL",
        usage: `Usage: polyant-cli agent channels whatsapp rotate <slug> --yes --confirm <slug>

The old URL stops working immediately and the new one is in the response — the
only copy. Update the Twilio Console before the next inbound message.`,
        action: whatsappRotate,
        mutates: true,
      },
    },
  },
  secrets: {
    show: {
      summary: "list which secrets an agent has configured",
      usage: "Usage: polyant-cli agent secrets show <slug> [--configured-only]",
      action: secretsShow,
    },
    set: {
      summary: "set one secret from a file or stdin",
      usage: `Usage: polyant-cli agent secrets set <slug> --key <name> --file <path|->

The value is read from a file or stdin, never from a flag: an inline secret lands
in shell history and in \`ps\`. It is never printed, not even in the recap — only
its length and where it came from.`,
      action: secretsSet,
      mutates: true,
    },
    unset: {
      summary: "remove one configured secret",
      usage: `Usage: polyant-cli agent secrets unset <slug> --key <name> --yes --confirm <name>

Refuses a key the agent does not declare, and one that is not configured: the
engine answers 200 either way, so without the check a typo would report success
while the real secret stayed in place.`,
      action: secretsUnset,
      mutates: true,
    },
  },
  hooks: {
    show: { summary: "list an agent's hooks", usage: "Usage: polyant-cli agent hooks show <slug>", action: hooksShow },
    add: {
      summary: "add a hook from a JSON file or stdin",
      usage: "Usage: polyant-cli agent hooks add <slug> --file <path|->",
      action: hooksAdd,
      mutates: true,
    },
    update: {
      summary: "patch a hook from a JSON file or stdin",
      usage: "Usage: polyant-cli agent hooks update <slug> <hookId> --file <path|->",
      action: hooksUpdate,
      mutates: true,
    },
    remove: {
      summary: "delete a hook",
      usage: "Usage: polyant-cli agent hooks remove <slug> <hookId> --yes --confirm <hookId>",
      action: hooksRemove,
      mutates: true,
    },
  },
  chat: {
    summary: "send one turn to an agent and stream the reply",
    usage: CHAT_USAGE,
    action: chat,
  },
  logs: {
    summary: "list or follow this agent's recorded tool events",
    usage: `Usage: polyant-cli agent logs <slug> [--tool <name>] [--action <name>] [--search <text>]
                                  [--from <iso>] [--to <iso>] [--limit <n>] [--offset <n>]
       polyant-cli agent logs <slug> --follow [--max <n>]`,
    action: logs,
  },
  conversations: {
    list: {
      summary: "list an agent's conversations",
      usage: `Usage: polyant-cli agent conversations list <slug> [--limit <n>] [--offset <n>] [--search <text>]
                                                     [--source <channel>] [--from <iso>] [--to <iso>]

--from/--to window the conversations by last update, half-open: --from is
inclusive, --to exclusive, so a single day is --from 2026-09-03 --to 2026-09-04.
The engine ignores the window when searching, so --search refuses to combine
with either.`,
      action: conversationsList,
    },
    show: {
      summary: "show one conversation and its messages",
      usage: "Usage: polyant-cli agent conversations show <slug> <conversationId> [--limit <n>]",
      action: conversationsShow,
    },
  },
  messages: {
    summary: "list messages across all of an agent's conversations",
    usage: `Usage: polyant-cli agent messages <slug> [--conversation <id>] [--role <user|assistant|system>]
                                      [--from <iso>] [--to <iso>] [--limit <n>] [--offset <n>]

The engine counts over at most 10001 matching rows, so a busy agent reports
"at least 10001" rather than a number it did not measure. A slug the key cannot
reach answers 404 or 403; it does not answer an empty list.`,
    action: messages,
  },
};

const AGENT_SUMMARIES: Record<string, string> = {
  agent: "manage agents, their configuration and their conversations",
  "agent a2a": "expose an agent over the Agent2Agent protocol",
  "agent channels": "manage an agent's channels",
  "agent channels whatsapp": "reveal and rotate the WhatsApp inbound webhook secret",
  "agent compliance": "an agent's model card, snapshots and reports",
  "agent conversations": "manage an agent's conversations",
  "agent events": "manage an agent's event sources",
  "agent governance": "assign and inspect an agent's governance policies",
  "agent hooks": "manage an agent's hooks",
  "agent knowledge": "manage an agent's knowledge documents",
  "agent mcp": "equip an agent with tools from external MCP servers",
  "agent memory": "manage what an agent has remembered",
  "agent optouts": "manage the contacts that have opted out of this agent",
  "agent prompt": "manage an agent's prompt",
  "agent retention": "manage an agent's data retention",
  "agent secrets": "manage an agent's secrets",
  "agent skills": "manage the skills an agent has enabled",
  "agent skills env": "manage a skill's environment on one agent",
  "agent tasks": "manage an agent's scheduled tasks",
  "agent tools": "manage an agent's tools",
};

/**
 * The families this file defines, plus the ones `agent-ops.ts` adds. Merged into
 * ONE tree rather than registered as a second top-level command: `agent skills`
 * and `agent tools` are the same kind of thing to whoever runs them, and which
 * file they happen to live in is not their business.
 */
export function createAgentCommand(overrides: Partial<AgentCommandDependencies> = {}): Command {
  const deps = { ...processServiceDependencies, ...overrides };
  return buildNode({ ...LEAVES, ...AGENT_FAMILY_EXTRAS, ...AGENT_INTEROP_EXTRAS, ...AGENT_DATA_EXTRAS }, deps, ["agent"], AGENT_SUMMARIES);
}

export const agentCommand = createAgentCommand();
