// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { parseArgs } from "node:util";
import { ConfigError } from "../exit.js";
import { loadWorkspaceConfig, resolveTarget, type ResolvedTarget } from "../config.js";
import { request } from "../api/client.js";
import type { HealthResponse, ListAgentsResponse } from "../api/types.js";
import type { Command } from "../command.js";

export const WHOAMI_USAGE = `Usage: polyant whoami [options]

Reports the active target, whether the instance answers, and the agents the
key can see.

Options:
  --json             emit a single JSON object instead of a text report
  --target <name>    target from polyant.yaml (default: its "default")
  --url <baseUrl>    override the target's baseUrl

A management API key cannot introspect its own permissions: /api/me/access
only serves user principals, so permissions are reported as not verified.`;

export interface WhoamiReport {
  target: string;
  baseUrl: string;
  prod: boolean;
  reachable: boolean;
  service: string | null;
  agents: { slug: string; status: string; authEnabled: boolean }[];
  /** Agents whose runtime routes are open to anyone (`authEnabled: false`). */
  openAgents: string[];
  /** Always "unverified" — there is no introspection endpoint for a service principal. */
  permissions: "unverified";
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

export async function collectWhoami(target: ResolvedTarget): Promise<WhoamiReport> {
  const health = await probeHealth(target);
  // The agent list is only meaningful once the instance answers at all.
  const agents = health.reachable ? await loadAgents(target) : {};
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
  };
}

export function renderWhoami(report: WhoamiReport): string {
  const lines = [
    `target:      ${report.target}${report.prod ? " (PROD)" : ""}`,
    `baseUrl:     ${report.baseUrl}`,
    `reachable:   ${report.reachable ? `yes (${report.service ?? "unknown service"})` : `no${report.unreachableReason ? ` — ${report.unreachableReason}` : ""}`}`,
    `permissions: not verified — no introspection endpoint for a management API key`,
  ];

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

async function run(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${WHOAMI_USAGE}\n`);
    return;
  }

  const args = parseWhoamiArgs(argv);
  const config = await loadWorkspaceConfig();
  const target = resolveTarget({
    config,
    env: process.env,
    ...(args.target === undefined ? {} : { target: args.target }),
    ...(args.url === undefined ? {} : { url: args.url }),
  });

  const report = await collectWhoami(target);

  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderWhoami(report)}\n`);

  // An agent with authEnabled false has completely open runtime routes: no
  // token required, no token validated. That belongs on stderr, loudly.
  for (const slug of report.openAgents) {
    process.stderr.write(
      `warning: agent "${slug}" has authEnabled=false — its /v1/chat/completions and chat/stream routes are open to anyone.\n`,
    );
  }
}

export const whoamiCommand: Command = {
  summary: "show the active target, reachability and visible agents",
  usage: WHOAMI_USAGE,
  run,
};
