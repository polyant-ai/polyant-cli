// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { CommandContext } from "../command.js";
import type { AgentCheck, AgentChecksResponse } from "../api/types.js";
import { CliError, ExitCode } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { call, expectArray, maybe, positiveInteger, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { Leaf, Node } from "../runtime/tree.js";
import { agentPath, preflight, reportWrite, requireSecond, requireSlug } from "../runtime/workspace.js";

/**
 * The supervision checks: what the engine has decided is wrong with an agent,
 * counted over a window of recent activity.
 *
 * Not `monitor status`, which reports what an agent IS — reachable, running,
 * configured. A check is a verdict over what it DID: a tool failing a quarter of
 * its calls, a hook pointing at nothing, a gate that never reached a verdict.
 *
 * The engine serves i18n KEYS rather than sentences, because the same checks
 * feed an Italian panel and an English one. The CLI prints the key and the
 * parameters that fill it, which is the whole of what the engine discloses:
 * inventing prose here would be a second wording nobody maintains.
 */

interface AgentChecksBody {
  instanceId?: unknown;
  name?: unknown;
  checks?: unknown;
  /** The ones silenced on this agent. Reported, so a silence is visible. */
  dismissed?: unknown;
  tally?: { broken?: unknown; warning?: unknown };
}

function paramsCell(params: AgentCheck["params"]): string {
  const entries = Object.entries(params ?? {});
  return entries.length === 0 ? "-" : entries.map(([key, value]) => `${key}=${value}`).join(" ");
}

function checkTable(checks: readonly AgentCheck[], empty: string): string {
  return renderTable({
    headers: ["ID", "SEVERITY", "SECTION", "DETAIL"],
    rows: checks.map((check) => [text(check.id), text(check.severity), text(check.section), paramsCell(check.params)]),
    emptyMessage: empty,
  });
}

/** `--days` narrows the window the counts are taken over; the engine clamps it. */
function windowDays(args: readonly string[]): Record<string, string> {
  return maybe("days", positiveInteger(takeValue(args, "--days"), "--days"));
}

async function checksShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "checks show");
  const options = args.slice(1);
  assertKnown(options, { value: ["--days"] }, "agent checks show option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/checks");
  const res = await call(deps, scope, { path, query: windowDays(options) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as AgentChecksBody;
  const checks = expectArray<AgentCheck>(body.checks, `GET ${path}`);
  const dismissed = Array.isArray(body.dismissed) ? (body.dismissed as AgentCheck[]) : [];
  // An empty list is the answer, not an empty state: "nothing fired" is what
  // lets a workspace say an agent is in order.
  deps.io.stdout(`${checkTable(checks, `Agent ${slug} raised nothing in the window.`)}\n`);
  if (dismissed.length > 0) {
    deps.io.stdout(`\nSilenced on this agent:\n${checkTable(dismissed, "")}\n`);
  }
  deps.io.stderr(`broken: ${text(body.tally?.broken)}  warning: ${text(body.tally?.warning)}  (counts exclude the silenced)\n`);
}

async function checkup(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "checkup");
  const options = args.slice(1);
  assertKnown(options, { value: ["--days"] }, "agent checkup option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/checks");
  const res = await call(deps, scope, { path, query: windowDays(options) });
  const body = (res.body ?? {}) as Partial<AgentChecksResponse>;
  const checks = expectArray<AgentCheck>(body.checks, `GET ${path}`);

  if (wantsJson(context)) {
    writeRawResponse(deps.io, res.raw);
  } else {
    deps.io.stderr(`broken: ${text(body.tally?.broken)}  warning: ${text(body.tally?.warning)}\n`);
    deps.io.stdout(`${renderTable({
      headers: ["SEVERITY", "CHECK", "SECTION", "PARAMS"],
      rows: checks.map((check) => [
        text(check.severity),
        text(check.id),
        text(check.section),
        check.params === undefined ? "-" : JSON.stringify(check.params),
      ]),
      emptyMessage: `No active checks for agent ${slug}.`,
    })}\n`);
  }

  if (checks.length > 0) throw new CliError(`Agent ${slug} has ${checks.length} active check(s).`, ExitCode.Difference);
}

interface DismissalRow {
  checkId: string;
  dismissedAt: string;
  dismissedBy: string | null;
  note: string | null;
}

async function dismissalsList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "checks dismissals");
  assertKnown(args.slice(1), {}, "agent checks dismissals option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/check-dismissals");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const dismissals = expectArray<DismissalRow>((res.body as { dismissals?: unknown } | null)?.dismissals, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["CHECK", "SINCE", "BY", "NOTE"],
      rows: dismissals.map((row) => [text(row.checkId), text(row.dismissedAt), text(row.dismissedBy), text(row.note)]),
      emptyMessage: `Agent ${slug} has no silenced checks.`,
    })}\n`,
  );
}

async function checksDismiss(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "checks dismiss");
  const checkId = requireSecond(args, "checks dismiss", "check id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--note", "--confirm"] }, "agent checks dismiss option");
  const note = takeValue(options, "--note");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Silence check ${checkId} on ${slug}`,
    changes: [
      // The invariant the whole drill-down rests on: a silenced check stops
      // counting at every tier, not only on the agent's own page.
      `${checkId} stops being listed and stops counting — on this agent, in the workspace dashboard, and in the organisation's.`,
      "It silences the verdict, not the cause: whatever the check measures keeps happening.",
      ...(note === undefined ? [] : [`Note: ${JSON.stringify(note)}.`]),
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "PUT",
    path: agentPath(slug, `/check-dismissals/${encodeURIComponent(checkId)}`),
    body: note === undefined ? {} : { note },
  });
  reportWrite(deps, context, res, `Silenced ${checkId} on ${slug}.`);
}

async function checksRestore(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "checks restore");
  const checkId = requireSecond(args, "checks restore", "check id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent checks restore option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Un-silence check ${checkId} on ${slug}`,
    changes: [`${checkId} is listed and counted again wherever it fires.`],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: agentPath(slug, `/check-dismissals/${encodeURIComponent(checkId)}`) });
  reportWrite(deps, context, res, `Restored ${checkId} on ${slug}.`);
}

interface HealthSignalsBody {
  windowDays?: unknown;
  tools?: unknown;
  hooks?: unknown;
  governanceBlocks?: unknown;
  /** Turns where a gate produced no verdict. NOT blocked turns — a separate count. */
  governanceUnevaluated?: unknown;
  llmCalls?: unknown;
  llmFailures?: unknown;
}

interface SubjectRow {
  name: string;
  calls?: number;
  runs?: number;
  failures: number;
}

async function healthSignals(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "health");
  const options = args.slice(1);
  assertKnown(options, { value: ["--days"] }, "agent health option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/health-signals");
  const res = await call(deps, scope, { path, query: windowDays(options) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as HealthSignalsBody;
  const tools = Array.isArray(body.tools) ? (body.tools as SubjectRow[]) : [];
  const hooks = Array.isArray(body.hooks) ? (body.hooks as SubjectRow[]) : [];
  deps.io.stdout(
    `${renderTable({
      headers: ["KIND", "NAME", "CALLS", "FAILURES"],
      rows: [
        ...tools.map((row) => ["tool", text(row.name), text(row.calls), text(row.failures)]),
        ...hooks.map((row) => ["hook", text(row.name), text(row.runs), text(row.failures)]),
      ],
      emptyMessage: `Agent ${slug} ran no tools or hooks in the window.`,
    })}\n`,
  );
  writePrettyResource(deps.io, [
    { label: "windowDays", value: text(body.windowDays) },
    { label: "governanceBlocks", value: text(body.governanceBlocks) },
    // Kept apart from the blocks deliberately: these turns were NOT blocked,
    // they proceeded with a check that did not run. Zero here is what tells a
    // quiet agent from a blind one.
    { label: "governanceUnevaluated", value: text(body.governanceUnevaluated) },
    { label: "llmCalls", value: text(body.llmCalls) },
    { label: "llmFailures", value: text(body.llmFailures) },
  ]);
}

async function workspaceChecks(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "analytics checks option");
  const scope = await scopeFor(deps, context, "read");
  const path = "/api/analytics/agent-checks";
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const agents = expectArray<AgentChecksBody & { instanceId: string; name: string }>(
    (res.body as { agents?: unknown } | null)?.agents,
    `GET ${path}`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["AGENT", "NAME", "BROKEN", "WARNING", "CHECKS"],
      rows: agents.map((agent) => [
        text(agent.instanceId),
        text(agent.name),
        text(agent.tally?.broken),
        text(agent.tally?.warning),
        (Array.isArray(agent.checks) ? (agent.checks as AgentCheck[]) : []).map((check) => check.id).join(", ") || "-",
      ]),
      emptyMessage: "This workspace has no agents.",
    })}\n`,
  );
}

const CHECK_NOTE =
  "The engine serves check IDs and i18n keys, not sentences: the same verdicts feed\nthe panel in every language. The ID is the stable name — it is what `checks\ndismiss` takes — and DETAIL is the measurement that raised it.";

/** The `agent checks` and `agent health` subtree. */
export const agentSupervisionFamily: Record<string, Node> = {
  checkup: {
    summary: "check whether an agent needs operational attention",
    usage: `Usage: polyant-cli agent checkup <slug> [--days <n>]

Prints live checks only and exits 1 when any are present, so automation can
distinguish an unhealthy agent from a command failure.`,
    action: checkup,
  },
  checks: {
    show: {
      summary: "what the engine finds wrong with this agent",
      usage: `Usage: polyant-cli agent checks show <slug> [--days <n>]

A verdict over what the agent DID in the window, which is a different question
from \`monitor status\` — that reports what it IS. An empty list is the answer,
not an empty state.

Silenced checks are listed separately underneath, so a silence is visible rather
than indistinguishable from a check that never fired. ${CHECK_NOTE}`,
      action: checksShow,
    },
    dismissals: {
      summary: "list the checks silenced on this agent",
      usage: "Usage: polyant-cli agent checks dismissals <slug>\n\nWho silenced each one, when, and why they said they did.",
      action: dismissalsList,
    },
    dismiss: {
      summary: "silence one check on this agent",
      usage: `Usage: polyant-cli agent checks dismiss <slug> <checkId> [--note <text>]

It stops counting at EVERY tier — the agent, the workspace dashboard and the
organisation's — which is what keeps the drill-down consistent with the page it
drills into. It silences the verdict, never the cause.`,
      action: checksDismiss,
      mutates: true,
    },
    restore: {
      summary: "un-silence one check on this agent",
      usage: "Usage: polyant-cli agent checks restore <slug> <checkId>",
      action: checksRestore,
      mutates: true,
    },
  },
  health: {
    summary: "the raw counts the checks are computed from",
    usage: `Usage: polyant-cli agent health <slug> [--days <n>]

Per tool and per hook: calls and failures. Underneath, the turn-level counts —
governance blocks, LLM calls and failures, and separately the turns where a gate
produced NO verdict. Those last are not blocked turns: they proceeded with a
check that did not run, and zero there is what tells a quiet agent from a blind
one.

This is what \`agent checks show\` reads; use it when a check fired and you want
the numbers behind it.`,
    action: healthSignals,
  },
};

/** The `analytics checks` leaf: the same verdicts, one tier up. */
export const analyticsChecks: Leaf = {
  summary: "every agent in the workspace, and what each is raising",
  usage: `Usage: polyant-cli analytics checks

The same checks \`agent checks show\` lists, counted per agent — one question
earlier: which agent should I open. Silenced checks are excluded here too, so
the count and the list cannot disagree. ${CHECK_NOTE}`,
  action: workspaceChecks,
};
