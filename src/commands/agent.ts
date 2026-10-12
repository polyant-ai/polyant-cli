// SPDX-License-Identifier: Apache-2.0
import type { ApiResponse } from "../api/client.js";
import type {
  AgentDetail,
  AgentDetailResponse,
  ChannelsResponse,
  ConversationsResponse,
  FeedEvent,
  HooksResponse,
  ListAgentsResponse,
  MessageListResponse,
  MessageStep,
  PromptsResponse,
  SecretsResponse,
  ToolsResponse,
} from "../api/types.js";
import type { Command, CommandContext } from "../command.js";
import { CliError, ConfigError, ExitCode, RemoteError } from "../exit.js";
import { writeCompositeJson, writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import {
  call,
  callStream,
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
import { agentSharedKnowledgeFamily } from "./knowledge-library.js";
import { agentSupervisionFamily } from "./supervision.js";
import { agentBudgetFamily } from "./budget.js";
import { agentVoiceFamily } from "./voice.js";
import { agentProvidersLeaf } from "./providers.js";
import { agentConnectionsFamily, agentProviderRolesFamily } from "./provider-roles.js";
import { AGENT_DATA_EXTRAS } from "./agent-data.js";
import { AGENT_INTEROP_EXTRAS } from "./agent-interop.js";
import { chat, CHAT_USAGE } from "./agent-chat.js";
import { createMonitorCommand, renderFeedEvent } from "./monitor.js";

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
    { label: "provider (stored)", value: text(agent.provider) },
    { label: "model (stored)", value: text(agent.model) },
    { label: "provider (effective)", value: text(agent.effectiveProvider) },
    { label: "model (effective)", value: text(agent.effectiveModel) },
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
  const changes = [
    ...Object.entries(body)
      .filter(([field]) => field !== "slug")
      .map(([field, value]) => `Set ${field} to ${JSON.stringify(value)}.`),
    // The engine's 1.2.0 defaults, said because both used to be on: an agent
    // copied by hand from an older one silently loses memory and voice messages.
    "Memory starts off and speech transcription disabled; turn them on with agent update.",
    // 1.2.0-ee: no provider key is read from a secret, so a new agent answers
    // nothing until its conversation has a connection.
    `It answers nothing until its chat role is bound: \`agent provider-roles bind ${slug} chat <connectionId>\`.`,
  ];
  if (!(await preflight(deps, scope, context, options, { title: `Create agent ${slug}`, changes }))) return;

  const res = await call(deps, scope, { method: "POST", path: "/api/instances", body });
  reportWrite(deps, context, res, `Created agent ${slug}.`);
}

function optional(options: readonly string[], flag: string, field: string): Record<string, string> {
  const value = takeValue(options, flag);
  return value === undefined ? {} : { [field]: value };
}

const UPDATE_FLAGS = {
  value: [
    "--name",
    "--description",
    "--provider",
    "--model",
    "--status",
    "--stt-provider",
    "--memory-scope",
    "--set",
    "--confirm",
  ],
} as const;

/**
 * Fields the DTO reports but nothing may write. Everything else the agent's own
 * read carries is offered to `--set`, so a field the engine adds is settable
 * here the day it ships instead of waiting for a flag.
 */
const READ_ONLY_FIELDS = new Set(["id", "slug", "workspaceId", "workspaceSlug", "createdAt", "updatedAt"]);

/**
 * `--set field=value`, repeatable, for the twenty-odd writable settings that do
 * not have a flag of their own — timezone, debounce, cache TTL, the opt-out
 * wording. A flag each would be a wall of options for fields most callers never
 * touch, and a hand-written list of them would be the exact drift that let six
 * settings reach the API and never be persisted.
 *
 * The value is read as JSON when it parses as one, so `--set cacheEnabled=true`
 * sends a boolean and `--set cacheTtl=300` a number; anything else is the string
 * it looks like, so `--set datetimeTimezone=Europe/Rome` needs no quoting.
 */
function parseSetFlags(options: readonly string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] !== "--set") continue;
    const pair = options[index + 1];
    if (pair === undefined || pair.startsWith("--")) throw new ConfigError("--set needs <field>=<value>.");
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new ConfigError(`--set needs <field>=<value>; got ${JSON.stringify(pair)}.`);
    const field = pair.slice(0, separator);
    const raw = pair.slice(separator + 1);
    if (READ_ONLY_FIELDS.has(field)) throw new ConfigError(`${field} is reported by the engine but cannot be written.`);
    if (Object.hasOwn(body, field)) throw new ConfigError(`--set names ${field} twice.`);
    try {
      body[field] = JSON.parse(raw) as unknown;
    } catch {
      body[field] = raw;
    }
  }
  return body;
}

/**
 * Request parameters the route acts on and never stores, so the instance it
 * answers with cannot echo them: `confirmWipe` authorises an embedder switch.
 */
const OPERATION_PARAMETERS = new Set(["confirmWipe"]);

/** Loose on purpose: the engine turns a numeric string into a number. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b) || String(a) === String(b);
}

/**
 * The engine copies a PATCH body through its own list of writable keys and
 * ignores anything else — silently, with a 200 and a fresh `updatedAt`. So the
 * write is verified against the instance the route ANSWERS with rather than
 * trusted: an ignored field would otherwise be reported here as a change that
 * happened.
 *
 * A field counts as ignored only when the answer still carries the value it had
 * BEFORE and the request asked for a different one. Comparing with the request
 * alone misread every value the engine normalises — keywords trimmed and
 * deduplicated, a temperature clamped, a field mapping rewritten — as a write
 * that did not happen.
 */
function unwrittenFields(
  requested: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown> | undefined,
): string[] {
  if (after === undefined) return [];
  return Object.keys(requested).filter((field) => {
    if (OPERATION_PARAMETERS.has(field)) return false;
    return !sameValue(requested[field], before[field]) && sameValue(before[field], after[field]);
  });
}

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

/**
 * Removed with engine 1.2.0-ee, where the engine answers 400 for
 * `providerConnectionId`. Named here so the flag fails pointing at its
 * replacement instead of as an unknown option.
 */
function refuseRemovedFlags(slug: string, options: readonly string[]): void {
  if (!options.includes("--provider-connection")) return;
  const connectionId = takeValue(options, "--provider-connection") ?? "<connectionId>";
  throw new ConfigError(
    "--provider-connection was removed: since engine 1.2.0-ee the agent's chat connection is a role binding. " +
      `Use polyant-cli agent provider-roles bind ${slug} chat ${connectionId}.`,
  );
}

async function update(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "update");
  const options = args.slice(1);
  refuseRemovedFlags(slug, options);
  assertKnown(options, UPDATE_FLAGS, "agent update option");
  const body: Record<string, unknown> = {
    ...optional(options, "--name", "name"),
    ...optional(options, "--description", "description"),
    ...optional(options, "--provider", "provider"),
    ...optional(options, "--model", "model"),
    ...optional(options, "--status", "status"),
    ...sttProvider(options),
    ...memoryScope(options),
    ...parseSetFlags(options),
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
    return String(previous) === String(value)
      ? `Leave ${field} unchanged at ${JSON.stringify(value)}.`
      : `Change ${field} from ${JSON.stringify(text(previous))} to ${JSON.stringify(value)}.`;
  });
  if (body.provider !== undefined && String(body.provider) !== String(current.provider)) {
    // The chat role's connection must be for the agent's provider, and the
    // engine does not rebind it: the agent stops until the role is bound again.
    changes.push(`The chat role must be bound to a connection for ${String(body.provider)}: see \`agent provider-roles show ${slug}\`.`);
  }
  if (!(await preflight(deps, scope, context, options, { title: `Update agent ${slug}`, changes }))) return;

  const res = await call(deps, scope, { method: "PATCH", path: `/api/instances/${encodeURIComponent(slug)}`, body });
  const after = (res.body as Partial<AgentDetailResponse> | null)?.instance as unknown as Record<string, unknown> | undefined;
  const ignored = unwrittenFields(body, current as unknown as Record<string, unknown>, after);
  if (ignored.length > 0) {
    // Exit 1, not 2: the request went through and the rest of it was written,
    // so this is a check that failed rather than a call to correct and repeat.
    throw new CliError(
      `The engine accepted the request and left ${ignored.join(", ")} as ${ignored.length === 1 ? "it was" : "they were"}; ` +
        "any other field in it was written. A field it does not treat as writable is ignored with a 200 and a fresh " +
        "updatedAt, so this is a mistyped name, an engine older than the field, or a value the engine normalised " +
        "back to the stored one — not a value that was rejected.",
      ExitCode.Difference,
    );
  }
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
  // Since 1.2.0 a plugin tool is named `<namespace>:<tool>` and the response
  // lists the plugins behind the served tools, so the namespace names its plugin.
  const plugins = new Map(
    ((res.body as Partial<ToolsResponse> | null)?.plugins ?? []).map((plugin) => [plugin.namespace, `${plugin.name}@${plugin.version}`]),
  );
  const pluginOf = (name: string): string => {
    const separator = name.indexOf(":");
    return separator <= 0 ? "-" : (plugins.get(name.slice(0, separator)) ?? name.slice(0, separator));
  };
  deps.io.stdout(
    `${renderTable({
      headers: ["NAME", "ENABLED", "CATEGORY", "SOURCE", "PLUGIN"],
      rows: tools.map((tool) => [tool.name, tool.enabled ? "yes" : "no", text(tool.category), text(tool.source), pluginOf(tool.name)]),
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

async function slackUrl(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "channels slack url");
  assertKnown(args.slice(1), {}, "agent channels slack url option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/channels/slack/webhook-url` });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);
  deps.io.stdout(`${text((res.body as { webhookUrl?: unknown } | null)?.webhookUrl)}\n`);
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
 *
 * Two reads, because `/secrets` lists the engine's well-known keys plus the ones
 * already STORED: a key an enabled tool declares — `s3_use_task_role` and
 * `aws_region` for fileUpload, `http_allowed_domains`, a plugin's own — shows up
 * there only once it is set, so checking against it alone refused exactly the
 * per-agent storage settings 1.2.0 asks to configure.
 */
interface DeclaredSecrets {
  secrets: SecretsResponse["secrets"];
  /**
   * The tools route answered 403: it needs `tool:read`, which a key scoped to
   * secrets alone does not hold. The listing then lacks tool keys not yet
   * stored, and whoever reads a refusal built on it has to be told why.
   */
  toolKeysUnreadable: boolean;
}

async function storedSecrets(deps: AgentCommandDependencies, scope: ResolvedScope, slug: string): Promise<SecretsResponse["secrets"]> {
  const res = await call(deps, scope, { path: secretsPath(slug) });
  return expectArray<SecretsResponse["secrets"][number]>(
    (res.body as Partial<SecretsResponse> | null)?.secrets,
    `GET ${secretsPath(slug)}`,
  );
}

async function secretsOf(deps: AgentCommandDependencies, scope: ResolvedScope, slug: string): Promise<DeclaredSecrets> {
  const listed = await storedSecrets(deps, scope, slug);
  const known = new Set(listed.map((secret) => secret.key));
  const declared = await toolDeclaredSecrets(deps, scope, slug);
  if (declared === undefined) return { secrets: listed, toolKeysUnreadable: true };
  return {
    secrets: [...listed, ...declared.filter((key) => !known.has(key)).map((key) => ({ key, configured: false }))],
    toolKeysUnreadable: false,
  };
}

/**
 * The keys the agent's enabled tools declare. An engine without the route
 * declares none; a key without `tool:read` gets `undefined`, because the
 * enrichment must not cost a secrets-only key the secrets it may manage.
 */
async function toolDeclaredSecrets(deps: AgentCommandDependencies, scope: ResolvedScope, slug: string): Promise<string[] | undefined> {
  try {
    const res = await call(deps, scope, { path: `/api/instances/${encodeURIComponent(slug)}/tools/required-secrets` });
    const specs = (res.body as { requiredSecrets?: { key?: unknown }[] } | null)?.requiredSecrets;
    return Array.isArray(specs) ? specs.map((spec) => spec.key).filter((key): key is string => typeof key === "string") : [];
  } catch (error) {
    if (error instanceof RemoteError && error.status === 404) return [];
    if (error instanceof RemoteError && error.status === 403) return undefined;
    throw error;
  }
}

/**
 * Since engine 1.2.0-ee a model, embedding or speech provider's key is held by a
 * connection, the secret listings stop offering it, and the secret routes refuse
 * it with a 400 naming the connection routes. The CLI keeps no list of those
 * keys (a plugin registers its own), so a refusal of an undeclared key says
 * where such a key went.
 */
const PROVIDER_KEYS_MOVED =
  "A model, embedding or speech provider key is no longer a secret: it is held by a provider connection bound to a role " +
  "(`agent connections create`, `agent provider-roles bind`).";

const TOOL_KEYS_UNREADABLE =
  "The keys this agent's tools declare need tool:read, which this key lacks, so a tool key that was never stored is not listed.";

async function secretsShow(args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies): Promise<void> {
  const slug = requireSlug(args, "secrets show");
  assertKnown(args.slice(1), { boolean: ["--configured-only"] }, "agent secrets show option");
  const scope = await scopeFor(deps, context, "read");
  if (wantsJson(context)) {
    const res = await call(deps, scope, { path: secretsPath(slug) });
    return writeRawResponse(deps.io, res.raw);
  }

  const { secrets: all, toolKeysUnreadable } = await secretsOf(deps, scope, slug);
  if (toolKeysUnreadable) deps.io.stderr(`note: ${TOOL_KEYS_UNREADABLE}\n`);
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

function assertDeclared({ secrets, toolKeysUnreadable }: DeclaredSecrets, key: string, slug: string): SecretsResponse["secrets"][number] {
  const found = secrets.find((secret) => secret.key === key);
  if (found !== undefined) return found;
  // A typo would otherwise be accepted as a new key by the engine, so the real
  // credential would stay untouched while the command reported success.
  throw new ConfigError(
    `Agent ${slug} declares no secret named ${JSON.stringify(key)}. Declared: ${secrets.map((secret) => secret.key).join(", ")}.` +
      (toolKeysUnreadable ? ` ${TOOL_KEYS_UNREADABLE}` : "") +
      ` ${PROVIDER_KEYS_MOVED}`,
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
  // Stored keys only: removing one needs nothing the tools route would add, and
  // `/secrets` lists every key that is stored.
  const existing = (await storedSecrets(deps, scope, slug)).find((secret) => secret.key === key);
  if (existing === undefined || !existing.configured) {
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
  assertKnown(options, { value: ["--limit", "--max"], boolean: ["--follow"] }, "agent conversations show option");
  const following = options.includes("--follow");
  const max = positiveInteger(takeValue(options, "--max"), "--max");
  if (max !== undefined && !following) throw new ConfigError("--max bounds --follow; it means nothing without it.");
  const scope = await scopeFor(deps, context, "read");
  // JSON Lines, like `monitor events --follow`: a composite document cannot be
  // streamed, so a JSON follow prints the live frames alone.
  if (following && wantsJson(context)) return followConversation(deps, scope, context, slug, id, max);
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
  if (following) await followConversation(deps, scope, context, slug, id, max);
}

/**
 * One conversation as it happens, on any channel (engine 1.2.0): the turn's
 * live events while it runs, and a `persisted` signal each time a message or a
 * hook run for it is stored — the cue to re-read the transcript, which the
 * signal itself does not carry. Never returns on its own: bound it with --max.
 */
async function followConversation(
  deps: AgentCommandDependencies,
  scope: ResolvedScope,
  context: CommandContext | undefined,
  slug: string,
  id: string,
  max: string | undefined,
): Promise<void> {
  const limit = max === undefined ? Infinity : Number(max);
  const stream = await callStream(deps, scope, {
    path: "/api/activity-stream/conversation",
    // `instanceId` takes the agent's SLUG here, whatever the name says.
    query: { conversationId: id, instanceId: slug },
    timeoutMs: 0,
  });
  if (!wantsJson(context)) deps.io.stderr(`following conversation ${id} — interrupt to stop\n`);

  let seen = 0;
  for await (const event of stream.events) {
    if (event.event === "persisted") {
      deps.io.stdout(
        wantsJson(context)
          ? `${JSON.stringify({ event: "persisted" })}\n`
          : `${new Date().toISOString()}  persisted  a message or hook run was stored\n`,
      );
    } else if (wantsJson(context)) {
      deps.io.stdout(`${event.data}\n`);
    } else {
      let parsed: FeedEvent | undefined;
      try {
        parsed = JSON.parse(event.data) as FeedEvent;
      } catch {
        parsed = undefined;
      }
      deps.io.stdout(`${parsed === undefined ? event.data : renderFeedEvent(parsed)}\n`);
    }
    seen += 1;
    if (seen >= limit) return;
  }
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
                                 [--set <field>=<value> ...]

--set reaches the writable settings with no flag of their own: the timezone and
locale, the debounce and typing delays, the cache TTL, the opt-out wording. The
value is read as JSON when it parses as one, so cacheEnabled=true sends a boolean
and datetimeTimezone=Europe/Rome a string. Run \`agent show <slug> --json\` for the
field names. Two worth knowing from engine 1.2.0: memoryEnabled=true, since new
agents start with memory off, and webContextFieldMapping='{"customerId":"customer.id"}',
which maps the \`context\` a web chat sends onto conversation state — the web twin
of the HTTP channel's mapping. Use \`agent providers <slug>\` to see which
--provider and --model values the agent may take.

The engine IGNORES a field it does not treat as writable — with a 200 and a fresh
updatedAt — so the response is checked: a field it asked to change and that comes
back with its old value exits 1, since the rest of the request was written. A
value the engine normalised (keywords trimmed, a temperature clamped) counts as
written. confirmWipe=true authorises an embedder switch that would delete the
agent's memories and knowledge, and is not checked, because nothing stores it.

The credential the agent runs on is not a field: since engine 1.2.0-ee it is a
role binding, set with \`agent provider-roles bind <slug> chat <connectionId>\`.
--provider-connection is gone, and the engine refuses providerConnectionId with
a 400 naming that route. Changing --provider leaves the chat role bound to a
connection for the old provider, which the agent can no longer use.

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
      usage: `Usage: polyant-cli agent prompt set <slug> --section <key> --file <path|->

This command reads current state to build an accurate recap. With --dry-run it
still performs that read, but sends no writes.`,
      action: promptSet,
      mutates: true,
    },
  },
  tools: {
    show: {
      summary: "list the tools available to an agent",
      usage: `Usage: polyant-cli agent tools show <slug> [--enabled-only]

PLUGIN names the plugin a namespaced tool (\`<namespace>:<tool>\`) comes from.
Since engine 1.2.0 the GitHub, Render, HubSpot and Markdown-to-PDF families are
plugins. The upgrade renames an agent's old flat names in place, so they stay
enabled and work again once the plugin is installed.`,
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
      usage: `Usage: polyant-cli agent channels set <slug> <type> --file <path|-> [--disable]

Since engine 1.2.0 Telegram and Slack arrive through webhooks, not through a
connection the engine opens. Slack takes botToken and signingSecret — there is
no appToken any more, and Socket Mode must be off in the Slack app, whose
Request URL is \`agent channels slack url\`. Telegram registers its own webhook
when the channel starts, so the engine needs a public HTTPS address with
/webhooks/* routed to it.

The voice channel takes its settings through \`agent channels voice settings
set\`, which validates the profile before saving; this command would store the
raw shape unchecked.`,
      action: channelsSet,
      mutates: true,
    },
    remove: {
      summary: "delete one channel's configuration and secrets",
      usage: "Usage: polyant-cli agent channels remove <slug> <type> --yes --confirm <type>",
      action: channelsRemove,
      mutates: true,
    },
    slack: {
      url: {
        summary: "print the Request URL to paste into the Slack app",
        usage: `Usage: polyant-cli agent channels slack url <slug>

The address Slack must POST events to, for the app's Event Subscriptions and
Interactivity Request URL. It carries no secret — Slack's signing secret
authenticates the request — so channel:read is enough. The engine builds it from
its public base URL: a localhost address means that base URL is not set.`,
        action: slackUrl,
      },
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
    voice: agentVoiceFamily,
  },
  secrets: {
    show: {
      summary: "list which secrets an agent has configured",
      usage: `Usage: polyant-cli agent secrets show <slug> [--configured-only]

The engine's well-known keys, the keys already stored, and the keys the agent's
enabled tools declare (fileUpload's s3_bucket_name, aws_region and
s3_use_task_role, httpRequest's http_allowed_domains, a plugin's own). Presence
only. With --json the engine's own list is printed unchanged, without the
tool-declared keys.

Since engine 1.2.0-ee a provider's key (openai_api_key, anthropic_api_key, the
aws_provider_* trio and the voice keys among them) is held by a connection, and
nothing reads it from here. A copy left by the upgrade is still listed while it
is stored, so it can be removed with \`secrets unset\`.`,
      action: secretsShow,
    },
    set: {
      summary: "set one secret from a file or stdin",
      usage: `Usage: polyant-cli agent secrets set <slug> --key <name> --file <path|->

The value is read from a file or stdin, never from a flag: an inline secret lands
in shell history and in \`ps\`. It is never printed, not even in the recap — only
its length and where it came from. A provider key is refused by the engine with
a 400 naming the connection routes: use \`agent connections create\` and
\`agent provider-roles bind\` instead.`,
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
      usage: `Usage: polyant-cli agent conversations show <slug> <conversationId> [--limit <n>]
       polyant-cli agent conversations show <slug> <conversationId> --follow [--max <n>]

--follow prints the transcript, then stays on the conversation: the engine
first replays the conversation's recent events, then sends each turn's events
live as it runs, on any channel, and a "persisted" line each time a
message or hook run is stored — re-run without --follow to read it. It has no
deadline: bound it with --max <n> events. With --json the follow prints the
live frames alone, as JSON Lines. Needs engine 1.2.0.`,
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
  "agent budget": "an agent's spend caps (Enterprise)",
  "agent channels": "manage an agent's channels",
  "agent channels slack": "the Slack inbound webhook address",
  "agent channels whatsapp": "reveal and rotate the WhatsApp inbound webhook secret",
  "agent channels voice": "the telephone voice channel: readiness and settings (Enterprise)",
  "agent channels voice settings": "read and replace the voice channel's settings",
  "agent compliance": "an agent's model card, snapshots and reports",
  "agent connections": "provider connections private to one agent (Enterprise)",
  "agent conversations": "manage an agent's conversations",
  "agent events": "manage an agent's event sources",
  "agent governance": "assign and inspect an agent's governance policies",
  "agent hooks": "manage an agent's hooks",
  "agent knowledge": "manage an agent's knowledge documents",
  "agent mcp": "equip an agent with tools from external MCP servers",
  "agent memory": "manage what an agent has remembered",
  "agent optouts": "manage the contacts that have opted out of this agent",
  "agent prompt": "manage an agent's prompt",
  "agent provider-roles": "which connection each of an agent's credential roles runs on (Enterprise)",
  "agent retention": "manage an agent's data retention",
  "agent checks": "the supervision verdicts raised on this agent",
  "agent secrets": "manage an agent's secrets",
  "agent shared-knowledge": "the shared library documents this agent draws on",
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
  return buildNode(
    {
      ...LEAVES,
      ...AGENT_FAMILY_EXTRAS,
      ...AGENT_INTEROP_EXTRAS,
      ...AGENT_DATA_EXTRAS,
      ...agentSupervisionFamily,
      "shared-knowledge": agentSharedKnowledgeFamily,
      budget: agentBudgetFamily,
      providers: agentProvidersLeaf,
      "provider-roles": agentProviderRolesFamily,
      connections: agentConnectionsFamily,
    },
    deps,
    ["agent"],
    AGENT_SUMMARIES,
  );
}

export const agentCommand = createAgentCommand();
