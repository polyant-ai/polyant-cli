// SPDX-License-Identifier: Apache-2.0
import type { AnalyticsResponse } from "../api/types.js";
import type { Command, CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { ORG_NOTE, orgPath, readScope } from "../runtime/org.js";
import { analyticsChecks } from "./supervision.js";
import { call, maybe, processServiceDependencies, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";

const RANGE_FLAGS = { value: ["--from", "--to"] } as const;

function range(options: readonly string[]): Record<string, string> {
  return { ...maybe("from", takeValue(options, "--from")), ...maybe("to", takeValue(options, "--to")) };
}

type LatencyOverview = NonNullable<AnalyticsResponse["latency"]>["overview"];

function latencyPercentiles(latency: LatencyOverview | undefined): string {
  if (latency === undefined) return "unavailable";
  if (latency.sampleCount === 0) return "no samples in this range";
  return `${latency.p50} / ${latency.p95} / ${latency.p99}`;
}

function report(deps: ServiceDependencies, body: Partial<AnalyticsResponse> | null, title: string): void {
  const overview = body?.overview;
  if (overview === undefined) throw new ConfigError(`${title} did not return an overview.`);
  const latency = body?.latency?.overview;

  writePrettyResource(deps.io, [
    { label: "conversations", value: text(overview.totalConversations) },
    { label: "messages", value: text(overview.totalMessages) },
    { label: "uniqueUsers", value: text(overview.uniqueUsers) },
    { label: "totalTokens", value: text(overview.totalTokens) },
    { label: "cachedInputTokens", value: text(overview.cachedInputTokens) },
    { label: "totalCost", value: text(overview.totalCost) },
    { label: "avgCostPerConversation", value: text(overview.avgCostPerConversation) },
    { label: "avgResponseTime", value: text(overview.avgResponseTime) },
    // The engine serves latency from a separate store, and percentiles over an
    // empty sample are zeros that read as "instant". Neither an absent block nor
    // an empty one may be printed as a p95 of 0.
    { label: "latency p50/p95/p99", value: latencyPercentiles(latency) },
    { label: "latency samples", value: latency === undefined ? "unavailable" : text(latency.sampleCount) },
  ]);

  deps.io.stdout(
    `\n${renderTable({
      headers: ["DATE", "CONVERSATIONS", "MESSAGES", "TOKENS", "COST"],
      rows: (body?.dailyTrend ?? []).map((row) => [
        text(row.date),
        text(row.conversations),
        text(row.messages),
        text(row.tokens),
        text(row.cost),
      ]),
      emptyMessage: "No daily activity in this range.",
    })}\n`,
  );

  deps.io.stdout(
    `\n${renderTable({
      headers: ["PROVIDER", "MODEL", "CALLS", "TOKENS", "COST", "AVG MS"],
      rows: (body?.modelDistribution ?? []).map((row) => [
        text(row.provider),
        text(row.model),
        text(row.calls),
        text(row.tokens),
        text(row.cost),
        text(row.avgDuration),
      ]),
      emptyMessage: "No model calls in this range.",
    })}\n`,
  );
}

async function overview(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, RANGE_FLAGS, "analytics overview option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: "/api/analytics", query: range(args) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = res.body as Partial<AnalyticsResponse> | null;
  report(deps, body, "GET /api/analytics");

  deps.io.stdout(
    `\n${renderTable({
      headers: ["AGENT", "NAME", "CONVERSATIONS", "TOKENS", "COST"],
      rows: (body?.instanceComparison ?? []).map((row) => [
        text(row.instanceId),
        text(row.name),
        text(row.conversations),
        text(row.tokens),
        text(row.cost),
      ]),
      emptyMessage: "No per-agent comparison in this range.",
    })}\n`,
  );
}

async function agent(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = args[0];
  if (slug === undefined || slug.startsWith("--")) throw new ConfigError("polyant-cli analytics agent needs an agent slug.");
  const options = args.slice(1);
  assertKnown(options, RANGE_FLAGS, "analytics agent option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    path: `/api/instances/${encodeURIComponent(slug)}/analytics`,
    query: range(options),
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = res.body as Partial<AnalyticsResponse> | null;
  report(deps, body, `GET /api/instances/${slug}/analytics`);

  deps.io.stdout(
    `\n${renderTable({
      headers: ["TOOL", "CALLS", "AVG MS", "P95", "SUCCESS RATE"],
      rows: (body?.latency?.slowestTools ?? []).map((row) => [
        text(row.tool),
        text(row.callCount),
        text(row.avgDurationMs),
        text(row.p95),
        text(row.successRate),
      ]),
      emptyMessage: "No tool latency samples in this range.",
    })}\n`,
  );
}

/**
 * The organisation-wide aggregate, which `overview` is not: `/api/analytics`
 * answers for the workspace the request addresses, and a deployment with several
 * workspaces has no way to add those up from it. Passed through whole — the
 * payload's shape is the answer, and it does not match the per-workspace one.
 */
async function organisation(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, RANGE_FLAGS, "analytics org option");
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: orgPath(org, "/analytics"), query: range(args) });
  writeRawResponse(deps.io, res.raw);
}

export function createAnalyticsCommand(overrides: Partial<ServiceDependencies> = {}): Command {
  const deps = { ...processServiceDependencies, ...overrides };
  return {
    summary: "report historical aggregates",
    usage: "Usage: polyant-cli analytics <action> [--from <iso>] [--to <iso>]",
    children: {
      overview: {
        summary: "workspace-wide cost, usage and latency",
        usage: "Usage: polyant-cli analytics overview [--from <iso>] [--to <iso>]",
        run: (args, context) => overview(args, context, deps),
      },
      agent: {
        summary: "one agent's cost, usage and slowest tools",
        usage: "Usage: polyant-cli analytics agent <slug> [--from <iso>] [--to <iso>]",
        run: (args, context) => agent(args, context, deps),
      },
      checks: {
        summary: analyticsChecks.summary,
        usage: analyticsChecks.usage,
        run: (args, context) => analyticsChecks.action(args, context, deps),
      },
      org: {
        summary: "every workspace in the organisation, aggregated",
        usage: `Usage: polyant-cli analytics org [--from <iso>] [--to <iso>]

\`overview\` answers for one workspace; this adds up all of them. ${ORG_NOTE}`,
        run: (args, context) => organisation(args, context, deps),
      },
    },
  };
}

export const analyticsCommand = createAnalyticsCommand();
