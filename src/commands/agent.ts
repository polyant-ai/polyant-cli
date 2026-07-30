// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { ApiResponse } from "../api/client.js";
import type {
  AgentDetail,
  AgentDetailResponse,
  ChannelsResponse,
  ConversationsResponse,
  HooksResponse,
  ListAgentsResponse,
  PromptsResponse,
  ToolsResponse,
} from "../api/types.js";
import type { Command, CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writeCompositeJson, writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { confirmMutation, type MutationPlan } from "../runtime/confirm.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import {
  call,
  expectArray,
  maybe,
  positiveInteger,
  processServiceDependencies,
  scopeFor,
  text,
  wantsJson,
  type ServiceDependencies,
} from "../runtime/service.js";
import type { ResolvedScope } from "../runtime/scope.js";
import { chat, CHAT_USAGE } from "./agent-chat.js";
import { createMonitorCommand } from "./monitor.js";

/** Kept as a name of its own so the agent tests read as agent tests. */
export type AgentCommandDependencies = ServiceDependencies;

function planScope(scope: ResolvedScope): MutationPlan["scope"] {
  return {
    target: scope.target.name,
    prod: scope.target.prod,
    ...(scope.org === undefined ? {} : { org: scope.org }),
    ...(scope.workspace === undefined ? {} : { workspace: scope.workspace }),
  };
}

async function preflight(
  deps: AgentCommandDependencies,
  scope: ResolvedScope,
  context: CommandContext | undefined,
  args: readonly string[],
  plan: Omit<MutationPlan, "scope">,
): Promise<boolean> {
  const confirm = takeValue(args, "--confirm");
  const decision = await confirmMutation(
    { ...plan, scope: planScope(scope) },
    {
      yes: context?.global.yes ?? false,
      dryRun: context?.global.dryRun ?? false,
      ...(confirm === undefined ? {} : { confirm }),
    },
    deps.io,
  );
  return decision.shouldWrite;
}

function requireSlug(args: readonly string[], action: string): string {
  const slug = args[0];
  if (slug === undefined || slug.startsWith("--")) throw new ConfigError(`polyant-cli agent ${action} needs an agent slug.`);
  return slug;
}

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
    { label: "name", value: text(agent.name) },
    { label: "description", value: text(agent.description) },
    { label: "status", value: text(agent.status) },
    { label: "provider", value: text(agent.provider) },
    { label: "model", value: text(agent.model) },
    { label: "authEnabled", value: text(agent.authEnabled) },
    { label: "memoryEnabled", value: text(agent.memoryEnabled) },
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

const UPDATE_FLAGS = { value: ["--name", "--description", "--provider", "--model", "--status", "--confirm"] } as const;

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

function reportWrite(deps: AgentCommandDependencies, context: CommandContext | undefined, res: ApiResponse, message: string): void {
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);
  deps.io.stdout(`${message}\n`);
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
      headers: ["TYPE", "ENABLED", "CONFIG KEYS"],
      rows: channels.map((channel) => [
        channel.channelType,
        channel.enabled ? "yes" : "no",
        Object.keys(channel.config ?? {}).sort().join(", ") || "-",
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
  assertKnown(options, { value: ["--limit", "--offset", "--search", "--source"] }, "agent conversations list option");
  const scope = await scopeFor(deps, context, "read");
  const query = {
    // instanceId carries the agent slug: the engine resolves it through
    // asInstanceSlug, not as a UUID.
    instanceId: slug,
    ...maybe("limit", positiveInteger(takeValue(options, "--limit"), "--limit")),
    ...maybe("offset", takeValue(options, "--offset")),
    ...maybe("search", takeValue(options, "--search")),
    ...maybe("source", takeValue(options, "--source")),
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
      headers: ["ROLE", "CREATED", "CONTENT"],
      rows: rows.map((message) => [text(message.role), text(message.createdAt), text(message.content).replaceAll("\n", " ")]),
      emptyMessage: "No messages in this conversation.",
    })}\n`,
  );
}

// --- command tree ----------------------------------------------------------

type Action = (args: string[], context: CommandContext | undefined, deps: AgentCommandDependencies) => Promise<void>;

interface Leaf {
  readonly summary: string;
  readonly usage: string;
  readonly action: Action;
  readonly mutates?: boolean;
}

const LEAVES: Record<string, Record<string, Leaf> | Leaf> = {
  list: { summary: "list the agents in the workspace", usage: "Usage: polyant-cli agent list", action: list },
  show: { summary: "show one agent's configuration", usage: "Usage: polyant-cli agent show <slug>", action: show },
  create: {
    summary: "create an agent",
    usage: "Usage: polyant-cli agent create <slug> --name <name> [--description <text>] [--provider <name>] [--model <id>]",
    action: create,
    mutates: true,
  },
  update: {
    summary: "change an agent's name, description, status, provider or model",
    usage: "Usage: polyant-cli agent update <slug> [--name <name>] [--description <text>] [--status <status>] [--provider <name>] [--model <id>]",
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
      summary: "list configured channels and their config key names",
      usage: "Usage: polyant-cli agent channels show <slug>",
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
      usage: "Usage: polyant-cli agent conversations list <slug> [--limit <n>] [--offset <n>] [--search <text>] [--source <channel>]",
      action: conversationsList,
    },
    show: {
      summary: "show one conversation and its messages",
      usage: "Usage: polyant-cli agent conversations show <slug> <conversationId> [--limit <n>]",
      action: conversationsShow,
    },
  },
};

function toCommand(leaf: Leaf, deps: AgentCommandDependencies): Command {
  return {
    summary: leaf.summary,
    usage: leaf.usage,
    ...(leaf.mutates === true ? { supportsDryRun: true } : {}),
    run: (args, context) => leaf.action(args, context, deps),
  };
}

function isLeaf(node: Record<string, Leaf> | Leaf): node is Leaf {
  return "action" in node;
}

export function createAgentCommand(overrides: Partial<AgentCommandDependencies> = {}): Command {
  const deps = { ...processServiceDependencies, ...overrides };
  const children: Record<string, Command> = {};
  for (const [name, node] of Object.entries(LEAVES)) {
    if (isLeaf(node)) {
      children[name] = toCommand(node, deps);
      continue;
    }
    const grandchildren: Record<string, Command> = {};
    for (const [action, leaf] of Object.entries(node)) grandchildren[action] = toCommand(leaf, deps);
    children[name] = {
      summary: `manage an agent's ${name}`,
      usage: `Usage: polyant-cli agent ${name} <action> [options]`,
      children: grandchildren,
    };
  }
  return {
    summary: "manage agents, their configuration and their conversations",
    usage: "Usage: polyant-cli agent <action> [options]",
    children,
  };
}

export const agentCommand = createAgentCommand();
