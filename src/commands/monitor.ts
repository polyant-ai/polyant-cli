// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type {
  AgentDetail,
  AiLogListResponse,
  AuditLogListResponse,
  AuditStatsResponse,
  FeedEvent,
  HealthResponse,
  ListAgentsResponse,
  TraceListResponse,
} from "../api/types.js";
import type { Command, CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
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
import type { ResolvedScope } from "../runtime/scope.js";

/**
 * A probe that either produced a body or failed. Monitoring exists to report
 * that difference: a metric the engine would not serve is reported as
 * unavailable together with its source error, never rendered as a zero.
 */
interface Probe {
  raw: string;
  body: unknown;
  error?: string;
  /** Kept so the command can report the whole picture and still fail. */
  cause?: unknown;
}

async function probe(deps: ServiceDependencies, scope: ResolvedScope, path: string): Promise<Probe> {
  try {
    const res = await call(deps, scope, { path });
    return { raw: res.raw, body: res.body };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { raw: JSON.stringify({ unavailable: reason }), body: null, error: reason, cause: error };
  }
}

async function status(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "monitor status option");
  const scope = await scopeFor(deps, context, "read");
  const health = await probe(deps, scope, "/health");
  const agents = await probe(deps, scope, "/api/instances");

  if (wantsJson(context)) {
    writeCompositeJson(deps.io, { health: health.raw, instances: agents.raw });
    return failIfDegraded(health, agents);
  }

  const service = (health.body as HealthResponse | null)?.service;
  writePrettyResource(deps.io, [
    { label: "target", value: `${scope.target.name}${scope.target.prod ? " (PROD)" : ""}` },
    { label: "baseUrl", value: scope.target.baseUrl },
    { label: "workspace", value: text(scope.workspace) },
    {
      label: "health",
      value: health.error === undefined ? `ok (${text(service)})` : `unavailable — ${health.error}`,
    },
  ]);

  if (agents.error !== undefined) {
    deps.io.stdout(`\nagents: unavailable — ${agents.error}\n`);
    return failIfDegraded(health, agents);
  }
  const instances = expectArray<AgentDetail>((agents.body as Partial<ListAgentsResponse> | null)?.instances, "GET /api/instances");
  deps.io.stdout(
    `\n${renderTable({
      headers: ["SLUG", "STATUS", "AUTH", "PROVIDER", "MODEL"],
      rows: instances.map((agent) => [
        agent.slug,
        text(agent.status),
        agent.authEnabled ? "on" : "OFF",
        text(agent.provider),
        text(agent.model),
      ]),
      emptyMessage: "No agents in this workspace.",
    })}\n`,
  );

  // authEnabled false means the agent's runtime routes require no token and
  // validate none. A status view that did not say so would be reassuring and
  // wrong.
  for (const open of instances.filter((agent) => !agent.authEnabled)) {
    deps.io.stderr(`warning: agent "${open.slug}" has authEnabled=false — its runtime routes are open to anyone.\n`);
  }
  failIfDegraded(health, agents);
}

/**
 * The whole report is printed first, then the command fails. `whoami` exits 0
 * on an unreachable instance by design, but `monitor status` is the health gate:
 * exiting 0 with a 403 in the output would make CI read a broken permission as a
 * healthy empty workspace.
 */
function failIfDegraded(...probes: readonly Probe[]): void {
  const failed = probes.find((entry) => entry.cause !== undefined);
  if (failed !== undefined) throw failed.cause;
}

const EVENT_FILTERS = [
  "--instance",
  "--conversation",
  "--tool",
  "--action",
  "--search",
  "--from",
  "--to",
  "--limit",
  "--offset",
  "--max",
] as const;

function eventQuery(options: readonly string[], forcedInstance: string | undefined): Record<string, string> {
  return {
    ...maybe("instanceId", forcedInstance ?? takeValue(options, "--instance")),
    ...maybe("conversationId", takeValue(options, "--conversation")),
    ...maybe("toolName", takeValue(options, "--tool")),
    ...maybe("action", takeValue(options, "--action")),
    ...maybe("search", takeValue(options, "--search")),
    ...maybe("from", takeValue(options, "--from")),
    ...maybe("to", takeValue(options, "--to")),
    ...maybe("limit", positiveInteger(takeValue(options, "--limit"), "--limit")),
    ...maybe("offset", takeValue(options, "--offset")),
  };
}

function renderFeedEvent(event: FeedEvent): string {
  const parts = [
    text(event.ts),
    text(event.instance?.slug),
    text(event.category ?? event.persona),
    ...(event.tool === undefined ? [] : [`tool=${event.tool.name}`]),
    ...(event.status === undefined ? [] : [`status=${event.status}`]),
    text(event.text).replaceAll("\n", " "),
  ];
  return parts.join("  ");
}

async function follow(
  options: readonly string[],
  context: CommandContext | undefined,
  deps: ServiceDependencies,
  scope: ResolvedScope,
  forcedInstance: string | undefined,
): Promise<void> {
  const instance = forcedInstance ?? takeValue(options, "--instance");
  const max = positiveInteger(takeValue(options, "--max"), "--max");
  const limit = max === undefined ? Infinity : Number(max);

  const stream = await callStream(deps, scope, {
    path: "/api/activity-stream/live",
    // The server-side filter is the one that matters: without it the socket
    // carries other agents' events and the CLI would be trusted to hide them.
    ...(instance === undefined ? {} : { query: { instance } }),
    timeoutMs: 0,
  });

  let seen = 0;
  for await (const event of stream.events) {
    if (wantsJson(context)) {
      // JSON Lines: one unmodified engine payload per line, so a consumer can
      // read the stream incrementally.
      deps.io.stdout(`${event.data}\n`);
    } else {
      let parsed: FeedEvent;
      try {
        parsed = JSON.parse(event.data) as FeedEvent;
      } catch {
        // A frame the engine did not shape as JSON is still evidence; print it
        // rather than dropping it silently.
        deps.io.stdout(`${event.data}\n`);
        seen += 1;
        if (seen >= limit) return;
        continue;
      }
      deps.io.stdout(`${renderFeedEvent(parsed)}\n`);
    }
    seen += 1;
    if (seen >= limit) return;
  }
}

async function events(
  args: string[],
  context: CommandContext | undefined,
  deps: ServiceDependencies,
  forcedInstance?: string,
): Promise<void> {
  const options = forcedInstance === undefined ? args : args.slice(1);
  assertKnown(options, { value: [...EVENT_FILTERS], boolean: ["--follow"] }, "monitor events option");
  const scope = await scopeFor(deps, context, "read");

  if (options.includes("--follow")) return follow(options, context, deps, scope, forcedInstance);

  const res = await call(deps, scope, { path: "/api/audit-logs", query: eventQuery(options, forcedInstance) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = res.body as Partial<AuditLogListResponse> | null;
  const items = expectArray<AuditLogListResponse["items"][number]>(body?.items, "GET /api/audit-logs");
  deps.io.stdout(
    `${renderTable({
      headers: ["CREATED", "AGENT", "TOOL", "ACTION", "OK", "MS", "ERROR"],
      rows: items.map((item) => [
        text(item.createdAt),
        text(item.instanceId),
        text(item.toolName),
        text(item.action),
        item.success ? "yes" : "NO",
        text(item.durationMs),
        text(item.error).replaceAll("\n", " "),
      ]),
      emptyMessage: "No events matched.",
    })}\n`,
  );
  deps.io.stderr(`${items.length} of ${text(body?.total)} events.\n`);
}

async function stats(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--instance", "--from", "--to"] }, "monitor stats option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    path: "/api/audit-logs/stats",
    query: {
      ...maybe("instanceId", takeValue(args, "--instance")),
      ...maybe("from", takeValue(args, "--from")),
      ...maybe("to", takeValue(args, "--to")),
    },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = res.body as Partial<AuditStatsResponse> | null;
  if (body === null || body.totalEntries === undefined) {
    throw new ConfigError("GET /api/audit-logs/stats did not return statistics.");
  }
  writePrettyResource(deps.io, [
    { label: "totalEntries", value: text(body.totalEntries) },
    { label: "errorCount", value: text(body.errorCount) },
    { label: "errorRate", value: text(body.errorRate) },
  ]);
  deps.io.stdout(
    `\n${renderTable({
      headers: ["TOOL", "COUNT"],
      rows: (body.byTool ?? []).map((row) => [text(row.toolName), text(row.count)]),
      emptyMessage: "No tool activity in this range.",
    })}\n`,
  );
}

const AI_LOG_FILTERS = [
  "--instance",
  "--conversation",
  "--model",
  "--tier",
  "--call-type",
  "--outcome",
  "--from",
  "--to",
  "--limit",
  "--offset",
] as const;

/**
 * The rows behind `analytics overview`.
 *
 * Deliberately unfiltered by outcome: the aggregate counts only calls that
 * returned, so summing COST here and comparing it with `analytics overview`
 * yields a difference that is real, not a bug. Pass `--outcome ok` to reproduce
 * the aggregate's basis.
 */
async function aiLogs(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: [...AI_LOG_FILTERS] }, "monitor ai-logs option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    path: "/api/ai-logs",
    query: {
      ...maybe("instanceId", takeValue(args, "--instance")),
      ...maybe("conversationId", takeValue(args, "--conversation")),
      ...maybe("model", takeValue(args, "--model")),
      ...maybe("tier", takeValue(args, "--tier")),
      ...maybe("callType", takeValue(args, "--call-type")),
      ...maybe("outcome", takeValue(args, "--outcome")),
      ...maybe("from", takeValue(args, "--from")),
      ...maybe("to", takeValue(args, "--to")),
      ...maybe("limit", positiveInteger(takeValue(args, "--limit"), "--limit")),
      ...maybe("offset", takeValue(args, "--offset")),
    },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = res.body as Partial<AiLogListResponse> | null;
  const items = expectArray<AiLogListResponse["items"][number]>(body?.items, "GET /api/ai-logs");
  deps.io.stdout(
    `${renderTable({
      headers: ["CREATED", "AGENT", "MODEL", "TYPE", "OUTCOME", "IN", "CACHED", "OUT", "COST", "MS"],
      rows: items.map((item) => [
        text(item.createdAt),
        text(item.instanceId),
        text(item.model),
        text(item.callType),
        item.outcome === "ok" ? "ok" : text(item.errorKind ?? item.outcome),
        text(item.promptTokens),
        text(item.cachedInputTokens),
        text(item.completionTokens),
        text(item.estimatedCostUsd),
        text(item.durationMs),
      ]),
      emptyMessage: "No LLM calls matched.",
    })}\n`,
  );
  deps.io.stderr(
    `${items.length} of ${cappedTotal(body)} calls. Failed calls are included; the analytics aggregate excludes them.\n`,
  );
}

const TRACE_FILTERS = ["--instance", "--conversation", "--from", "--to", "--limit", "--offset"] as const;

/** One row per turn: the phase breakdown the latency percentiles only summarise. */
async function traces(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: [...TRACE_FILTERS] }, "monitor traces option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    path: "/api/pipeline-traces",
    query: {
      ...maybe("instanceId", takeValue(args, "--instance")),
      ...maybe("conversationId", takeValue(args, "--conversation")),
      ...maybe("from", takeValue(args, "--from")),
      ...maybe("to", takeValue(args, "--to")),
      ...maybe("limit", positiveInteger(takeValue(args, "--limit"), "--limit")),
      ...maybe("offset", takeValue(args, "--offset")),
    },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = res.body as Partial<TraceListResponse> | null;
  const items = expectArray<TraceListResponse["items"][number]>(body?.items, "GET /api/pipeline-traces");
  deps.io.stdout(
    `${renderTable({
      headers: ["CREATED", "AGENT", "CHANNEL", "MODEL", "TOTAL MS", "LLM MS", "TTFB MS", "CONVERSATION"],
      rows: items.map((item) => [
        text(item.createdAt),
        text(item.instanceId),
        text(item.channel),
        text(item.model),
        text(item.totalMs),
        text(item.llmCallMs),
        text(item.ttfbMs),
        text(item.conversationId),
      ]),
      emptyMessage: "No turns matched.",
    })}\n`,
  );
  deps.io.stderr(`${items.length} of ${cappedTotal(body)} turns.\n`);
}

export interface MonitorActions {
  /** `agent logs <slug>` is this query with the instance filter forced. */
  events(args: string[], context: CommandContext | undefined, forcedInstance?: string): Promise<void>;
}

const EVENTS_USAGE = `Usage: polyant-cli monitor events [--instance <slug>] [--conversation <id>] [--tool <name>]
                                 [--action <name>] [--search <text>] [--from <iso>] [--to <iso>]
                                 [--limit <n>] [--offset <n>]
       polyant-cli monitor events --follow [--instance <slug>] [--max <n>]

--conversation narrows to one conversation's tool calls, which is how a turn's
audit trail lines up with \`monitor traces\` and \`agent messages\` for the same id.
Every row also carries the assistant message it served; that is in --json, not
in the table.`;

export function createMonitorCommand(overrides: Partial<ServiceDependencies> = {}): { command: Command; actions: MonitorActions } {
  const deps = { ...processServiceDependencies, ...overrides };
  return {
    command: {
      summary: "report current state and live activity",
      usage: "Usage: polyant-cli monitor <action> [options]",
      children: {
        status: {
          summary: "report reachability and every agent's current state",
          usage: "Usage: polyant-cli monitor status",
          run: (args, context) => status(args, context, deps),
        },
        events: {
          summary: "list recorded tool events, or follow live activity",
          usage: EVENTS_USAGE,
          run: (args, context) => events(args, context, deps),
        },
        stats: {
          summary: "summarise recorded events by tool",
          usage: "Usage: polyant-cli monitor stats [--instance <slug>] [--from <iso>] [--to <iso>]",
          run: (args, context) => stats(args, context, deps),
        },
        "ai-logs": {
          summary: "list raw LLM calls, with their cost and cache breakdown",
          usage: `Usage: polyant-cli monitor ai-logs [--instance <slug>] [--conversation <id>] [--model <name>]
                                   [--tier <fast|standard|heavy>] [--call-type <conversation|service>]
                                   [--outcome <ok|error>] [--from <iso>] [--to <iso>]
                                   [--limit <n>] [--offset <n>]

The engine counts over at most 10001 matching rows, so a busy window reports
"at least 10001" rather than a number it did not measure. Narrow the window, or
page with --limit/--offset. An --instance the key cannot reach answers 404 or
403; it does not answer an empty list.`,
          run: (args, context) => aiLogs(args, context, deps),
        },
        traces: {
          summary: "list raw turn traces, with their phase timings",
          usage: `Usage: polyant-cli monitor traces [--instance <slug>] [--conversation <id>]
                                  [--from <iso>] [--to <iso>] [--limit <n>] [--offset <n>]

The engine counts over at most 10001 matching rows, so a busy window reports
"at least 10001" rather than a number it did not measure. Narrow the window, or
page with --limit/--offset. An --instance the key cannot reach answers 404 or
403; it does not answer an empty list.`,
          run: (args, context) => traces(args, context, deps),
        },
      },
    },
    actions: {
      events: (args, context, forcedInstance) => events(args, context, deps, forcedInstance),
    },
  };
}

export const { command: monitorCommand, actions: monitorActions } = createMonitorCommand();
