// SPDX-License-Identifier: Apache-2.0
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { call, expectArray, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";
import { agentPath, preflight, reportWrite, requireSlug } from "../runtime/workspace.js";
import { parseObject } from "./governance.js";

/**
 * An agent's spend caps (Enterprise, engine 1.2.0).
 *
 * The engine guards every model call against them — tool loops, sub-agents and
 * service work included — and stops the agent with `stopMessage` once one is
 * reached. They are SOFT caps over committed counters: calls already in flight
 * finish, so a cap stops what comes after the accounting catches up, never with
 * a guaranteed bound on the overshoot. The recap says so, because "set a $50 cap"
 * reads as a promise the engine does not make.
 */

/** The calendar windows the engine counts in, in the engine's own order. */
const PERIODS = ["hour", "day", "week", "month", "quarter", "four_month", "semester"] as const;

const LIMIT_FIELDS = ["conversationUsd", "periods", "contactPeriods"] as const;

interface BudgetWindow {
  period: string;
  limitUsd: number;
  spentUsd: number;
}

interface BudgetBody {
  limits?: { conversationUsd?: number; periods?: Record<string, number>; contactPeriods?: Record<string, number> };
  stopMessage?: string;
  stopMessageIsDefault?: boolean;
  windows?: unknown;
}

function usd(value: unknown): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "-";
}

function periodList(periods: Record<string, number> | undefined): string {
  const entries = Object.entries(periods ?? {});
  return entries.length === 0 ? "(none)" : entries.map(([period, limit]) => `${period} ${usd(limit)}`).join(", ");
}

async function budgetShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "budget show");
  assertKnown(args.slice(1), {}, "agent budget show option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/budget");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as BudgetBody;
  const windows = expectArray<BudgetWindow>(body.windows, `GET ${path}`);
  writePrettyResource(deps.io, [
    { label: "per conversation", value: body.limits?.conversationUsd === undefined ? "(none)" : usd(body.limits.conversationUsd) },
    { label: "agent-wide", value: periodList(body.limits?.periods) },
    // Counted separately for every real contact; service, room, scheduler and
    // agent-to-agent identifiers never become contacts.
    { label: "per contact", value: periodList(body.limits?.contactPeriods) },
    { label: "stop message", value: `${text(body.stopMessage)}${body.stopMessageIsDefault === true ? " (default)" : ""}` },
  ]);
  // The current agent-wide windows only: per-contact and per-conversation
  // spend has one counter per contact or conversation, which the route does not list.
  deps.io.stdout(
    `\n${renderTable({
      headers: ["PERIOD", "LIMIT", "SPENT"],
      rows: windows.map((window) => [text(window.period), usd(window.limitUsd), usd(window.spentUsd)]),
      emptyMessage: `Agent ${slug} has no agent-wide spend cap.`,
    })}\n`,
  );
}

function isAmount(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The engine's schema, checked before anything is sent: it is strict, so a
 * misspelt period or field is a 400 naming a Zod path — better refused here
 * naming the windows that exist.
 */
function validateLimits(limits: unknown): Record<string, unknown> {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    throw new ConfigError("The budget payload needs limits as an object, {} to remove every cap.");
  }
  const record = limits as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!(LIMIT_FIELDS as readonly string[]).includes(field)) {
      throw new ConfigError(`limits.${field} is not a budget field. Fields: ${LIMIT_FIELDS.join(", ")}.`);
    }
  }
  if (record.conversationUsd !== undefined && !isAmount(record.conversationUsd)) {
    throw new ConfigError(`limits.conversationUsd must be a positive number of USD; got ${JSON.stringify(record.conversationUsd)}.`);
  }
  for (const field of ["periods", "contactPeriods"] as const) {
    const periods = record[field];
    if (periods === undefined) continue;
    if (typeof periods !== "object" || periods === null || Array.isArray(periods)) {
      throw new ConfigError(`limits.${field} must map a period to a USD amount.`);
    }
    for (const [period, amount] of Object.entries(periods)) {
      if (!(PERIODS as readonly string[]).includes(period)) {
        throw new ConfigError(`limits.${field}.${period} is not a period. Periods: ${PERIODS.join(", ")}.`);
      }
      if (!isAmount(amount)) {
        throw new ConfigError(`limits.${field}.${period} must be a positive number of USD; got ${JSON.stringify(amount)}.`);
      }
    }
  }
  return record;
}

async function budgetSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "budget set");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file"] }, "agent budget set option");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError("polyant-cli agent budget set needs --file <path> (or --file - for stdin).");
  const body = parseObject(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);
  for (const field of Object.keys(body)) {
    if (field !== "limits" && field !== "stopMessage") {
      throw new ConfigError(`The budget payload takes limits and stopMessage; ${field} is not one of them.`);
    }
  }
  const limits = validateLimits(body.limits);
  if (body.stopMessage !== undefined && typeof body.stopMessage !== "string") {
    throw new ConfigError("stopMessage must be a string; omit it, or send \"\", to use the default.");
  }

  const conversation = limits.conversationUsd;
  const periods = limits.periods as Record<string, number> | undefined;
  const contactPeriods = limits.contactPeriods as Record<string, number> | undefined;
  const none = conversation === undefined && Object.keys(periods ?? {}).length === 0 && Object.keys(contactPeriods ?? {}).length === 0;

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Set ${slug}'s spend caps`,
    changes: none
      ? [`Remove every spend cap from ${slug}: nothing stops it on cost.`]
      : [
          ...(conversation === undefined ? [] : [`Stop a conversation once it has cost ${usd(conversation)}.`]),
          ...(periods === undefined || Object.keys(periods).length === 0 ? [] : [`Agent-wide: ${periodList(periods)}.`]),
          ...(contactPeriods === undefined || Object.keys(contactPeriods).length === 0
            ? []
            : [`Per contact: ${periodList(contactPeriods)}.`]),
          "The payload replaces the whole policy: a cap it does not name is removed.",
          // Committed counters, reconciled before each admission: a call in
          // flight finishes, so the cap holds for what comes after, not exactly.
          "Soft caps: calls already in flight finish, and a cap blocks later calls once accounting catches up.",
          // Length and source, never the text: AGENTS.md holds every payload
          // recap to that, and `budget show` is where the stored wording is read.
          body.stopMessage === undefined || body.stopMessage === ""
            ? "Once a cap is reached the agent answers with the default stop message."
            : `Once a cap is reached the agent answers with a custom stop message: ${body.stopMessage.length} characters from ${file === "-" ? "stdin" : file}.`,
        ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PUT", path: agentPath(slug, "/budget"), body });
  reportWrite(deps, context, res, `Set the spend caps on ${slug}.`);
}

/** The `agent budget` subtree. */
export const agentBudgetFamily: Record<string, Node> = {
  show: {
    summary: "show an agent's spend caps and what the current windows have cost",
    usage: `Usage: polyant-cli agent budget show <slug>

The caps, the stop message, and for each agent-wide cap the current window's
limit and spend. Per-conversation and per-contact spend is counted too, one
counter each, and is not listed. Enterprise only, engine 1.2.0-ee or later.`,
    action: budgetShow,
  },
  set: {
    summary: "replace an agent's spend caps from a JSON file or stdin",
    usage: `Usage: polyant-cli agent budget set <slug> --file <path|->

The payload replaces the whole policy:

  {
    "limits": {
      "conversationUsd": 2,
      "periods": { "day": 20, "month": 300 },
      "contactPeriods": { "day": 1 }
    },
    "stopMessage": "I have reached my limit for today."
  }

Periods: ${PERIODS.join(", ")}. Amounts are positive USD. "limits": {}
removes every cap; an omitted or empty stopMessage uses the default.

These are soft caps over committed counters: a call already in flight finishes,
and a cap blocks later calls once accounting catches up. Needs governance:write.`,
    action: budgetSet,
    mutates: true,
  },
};
