// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { parseArgs } from "node:util";
import { ConfigError } from "../exit.js";
import { loadWorkspaceConfig, type ResolvedTarget } from "../config.js";
import { request } from "../api/client.js";
import type { HealthResponse, ListAgentsResponse } from "../api/types.js";
import type { Command, CommandContext } from "../command.js";
import { resolveScope } from "../runtime/scope.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import { processOutput } from "../render/output.js";

export const WHOAMI_USAGE = `Usage: polyant-cli whoami [options]

Reports the active target, whether the instance answers, and the agents the
key can see.

Options:
  --json             emit a single JSON object instead of a text report
  --target <name>    target from polyant.yaml (default: its "default")
  --url <baseUrl>    override the target's baseUrl

Permissions come from /api/service-context when the engine serves it. Until
that contract lands, they are reported as not verified rather than guessed:
/api/me/access serves user principals only.

This command exits 0 whenever it can resolve a target, even if the instance
never answers — reporting an unreachable instance is its job, not a failure of
its own. Read the "reachable" field. If you need a non-zero exit for a health
gate, use "polyant-cli api GET /health" instead.`;

export interface WhoamiReport {
  target: string;
  baseUrl: string;
  prod: boolean;
  reachable: boolean;
  service: string | null;
  agents: { slug: string; status: string; authEnabled: boolean }[];
  /** Agents whose runtime routes are open to anyone (`authEnabled: false`). */
  openAgents: string[];
  /**
   * The key's effective permission keys, or "unverified" when the engine serves
   * no introspection route for a service principal. Never a guess: an empty
   * array would claim the key can do nothing, which is a different statement.
   */
  permissions: "unverified" | string[];
  /** The key's own organisation, when service-context reports it. */
  organization?: { id: string; slug: string; name: string };
  /** Workspaces the key may address, when service-context reports them. */
  workspaces?: { id: string; slug: string; isDefault: boolean }[];
  /** Why /health did not answer, when it did not. */
  unreachableReason?: string;
  /** Why the agent list is empty, when it is. */
  agentsError?: string;
}

async function probeHealth(target: ResolvedTarget): Promise<Partial<WhoamiReport>> {
  try {
    const res = await request(target, { path: "/health" });
    const body = res.body as HealthResponse | null;
    return { reachable: true, service: typeof body?.service === "string" ? body.service : null };
  } catch (error) {
    return {
      reachable: false,
      unreachableReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadAgents(target: ResolvedTarget): Promise<Partial<WhoamiReport>> {
  try {
    const res = await request(target, { path: "/api/instances" });
    const instances = (res.body as Partial<ListAgentsResponse> | null)?.instances;
    // Without this check a wrong shape reaches `.map()` and surfaces as a raw
    // TypeError — caught below, but reported to the user as a JS-engine message
    // about undefined properties instead of something they can act on.
    if (!Array.isArray(instances)) {
      throw new Error("GET /api/instances did not return an instances array");
    }
    const agents = instances.map((a) => ({
      slug: a.slug,
      status: a.status,
      authEnabled: a.authEnabled,
    }));
    return { agents, openAgents: agents.filter((a) => !a.authEnabled).map((a) => a.slug) };
  } catch (error) {
    return { agentsError: error instanceof Error ? error.message : String(error) };
  }
}

/** The route the CLI expects; named once so the report can point at it. */
const SERVICE_CONTEXT_PATH = "/api/service-context";

/**
 * Introspection is optional by design: the route is a pending engine contract,
 * so a 404 or 403 is an expected answer and must leave the report honest rather
 * than fail the command.
 */
async function probeServiceContext(target: ResolvedTarget): Promise<Partial<WhoamiReport>> {
  try {
    const res = await request(target, { path: SERVICE_CONTEXT_PATH });
    const body = res.body as
      | { permissions?: unknown; principal?: { organization?: unknown }; workspaces?: unknown }
      | null;
    const permissions = body?.permissions;
    if (!Array.isArray(permissions) || !permissions.every((entry) => typeof entry === "string")) {
      // A 200 the CLI cannot read is a contract mismatch, not an absent route.
      // Staying silent here makes the two indistinguishable, which is exactly
      // the case an operator wiring the endpoint up needs to tell apart.
      processOutput.stderr(
        `warning: GET ${SERVICE_CONTEXT_PATH} answered ${res.status} but its shape was not recognised — ` +
          `expected a top-level "permissions" array of strings. Reporting permissions as unverified.\n`,
      );
      return {};
    }
    const organization = body?.principal?.organization;
    const workspaces = body?.workspaces;
    return {
      permissions: [...permissions].sort(),
      ...(isOrganization(organization) ? { organization } : {}),
      ...(Array.isArray(workspaces) ? { workspaces: workspaces as WhoamiReport["workspaces"] } : {}),
    };
  } catch {
    // Not reported as an error: the absence of the route is the current state of
    // the engine, and "unverified" already says so.
    return {};
  }
}

function isOrganization(value: unknown): value is NonNullable<WhoamiReport["organization"]> {
  return value !== null && typeof value === "object" && "slug" in value && "id" in value;
}

export async function collectWhoami(target: ResolvedTarget): Promise<WhoamiReport> {
  const health = await probeHealth(target);
  // The agent list is only meaningful once the instance answers at all.
  const agents = health.reachable ? await loadAgents(target) : {};
  const identity = health.reachable ? await probeServiceContext(target) : {};
  return {
    target: target.name,
    baseUrl: target.baseUrl,
    prod: target.prod,
    reachable: false,
    service: null,
    agents: [],
    openAgents: [],
    permissions: "unverified",
    ...health,
    ...agents,
    ...identity,
  };
}

export function renderWhoami(report: WhoamiReport): string {
  const lines = [
    `target:      ${report.target}${report.prod ? " (PROD)" : ""}`,
    `baseUrl:     ${report.baseUrl}`,
    `reachable:   ${report.reachable ? `yes (${report.service ?? "unknown service"})` : `no${report.unreachableReason ? ` — ${report.unreachableReason}` : ""}`}`,
    Array.isArray(report.permissions)
      ? `permissions: ${report.permissions.length === 0 ? "(none granted)" : report.permissions.join(", ")}`
      : `permissions: not verified — no usable GET ${SERVICE_CONTEXT_PATH} for a management API key`,
    ...(report.organization === undefined ? [] : [`org:         ${report.organization.slug} (${report.organization.id})`]),
  ];

  if (report.workspaces !== undefined) {
    lines.push("", `workspaces (${report.workspaces.length}):`);
    for (const workspace of report.workspaces) {
      lines.push(`  ${workspace.slug}  ${workspace.id}${workspace.isDefault ? "  (default)" : ""}`);
    }
  }

  if (report.agents.length > 0) {
    lines.push("", `agents (${report.agents.length}):`);
    for (const agent of report.agents) {
      lines.push(`  ${agent.slug}  status=${agent.status}  authEnabled=${agent.authEnabled}`);
    }
  } else {
    lines.push("", `agents: none visible${report.agentsError ? ` — ${report.agentsError}` : ""}`);
  }

  return lines.join("\n");
}

function parseWhoamiArgs(argv: string[]): { json: boolean; target?: string; url?: string } {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        target: { type: "string" },
        url: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    });
    return {
      json: values.json === true,
      ...(typeof values.target === "string" ? { target: values.target } : {}),
      ...(typeof values.url === "string" ? { url: values.url } : {}),
    };
  } catch (error) {
    throw new ConfigError(`${error instanceof Error ? error.message : String(error)}\n\n${WHOAMI_USAGE}`);
  }
}

/** Lets direct command callers retain local --target parsing while the runtime owns global flags. */
function globalForScope(context: CommandContext | undefined, target: string | undefined): GlobalOptions {
  const global = context?.global;
  if (global === undefined) return { json: false, yes: false, dryRun: false, ...(target === undefined ? {} : { target }) };
  return global.target === undefined && target !== undefined ? { ...global, target } : global;
}

async function run(argv: string[], context?: CommandContext): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    processOutput.stdout(`${WHOAMI_USAGE}\n`);
    return;
  }

  const args = parseWhoamiArgs(argv);
  const config = await loadWorkspaceConfig();
  const target = resolveScope({
    config,
    env: process.env,
    global: globalForScope(context, args.target),
    ...(args.url === undefined ? {} : { url: args.url }),
    required: ["target"],
  }).target;

  const report = await collectWhoami(target);

  const json = context?.global.json ?? args.json;
  processOutput.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : `${renderWhoami(report)}\n`);

  // An agent with authEnabled false has completely open runtime routes: no
  // token required, no token validated. That belongs on stderr, loudly.
  for (const slug of report.openAgents) {
    processOutput.stderr(
      `warning: agent "${slug}" has authEnabled=false — its /v1/chat/completions and chat/stream routes are open to anyone.\n`,
    );
  }
}

export const whoamiCommand = {
  summary: "show the active target, reachability and visible agents",
  usage: WHOAMI_USAGE,
  run,
} satisfies Command;
