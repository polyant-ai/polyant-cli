// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { ORG_NOTE, orgPath, preflight, readScope, report, requirePositional } from "../runtime/org.js";
import { call, expectArray, maybe, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";

/**
 * Governance splits across two scopes, and the split is the thing to keep
 * straight: the policy CATALOG is owned by the organisation
 * (`/api/organizations/:orgSlug/governance/policies`), while `overview`,
 * `analytics`, `tools` and `metadata` under `/api/governance` answer for the
 * addressed WORKSPACE or the deployment. Assigning a policy to an agent is a
 * third thing again — `agent governance`.
 */
function range(args: readonly string[]): Record<string, string> {
  return { ...maybe("from", takeValue(args, "--from")), ...maybe("to", takeValue(args, "--to")) };
}

async function governanceOverview(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "governance overview option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: "/api/governance/overview" });
  writeRawResponse(deps.io, res.raw);
}

async function governanceAnalytics(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--from", "--to"], boolean: ["--org"] }, "governance analytics option");
  // Two different aggregations behind one word: the workspace route answers for
  // the workspace the request addresses, the organisation route for every
  // workspace in it. Naming both "analytics" and picking by flag keeps the
  // distinction visible instead of hiding it in a slug.
  if (args.includes("--org")) {
    const { scope, org } = await readScope(deps, context);
    const res = await call(deps, scope, { path: orgPath(org, "/governance/analytics"), query: range(args) });
    return writeRawResponse(deps.io, res.raw);
  }
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: "/api/governance/analytics", query: range(args) });
  writeRawResponse(deps.io, res.raw);
}

async function governanceTools(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "governance tools option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: "/api/governance/tools" });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const tools = expectArray<{ name: string; description?: string }>(
    (res.body as { tools?: unknown } | null)?.tools,
    "GET /api/governance/tools",
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["NAME", "DESCRIPTION"],
      rows: tools.map((tool) => [text(tool.name), text(tool.description)]),
      emptyMessage: "This organisation is granted no tools.",
    })}\n`,
  );
}

async function governanceMetadata(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "governance metadata option");
  const scope = await scopeFor(deps, context, "read");
  // The gate types, categories and severities a policy may name. Passed through
  // whole: it is the vocabulary for `governance policy create`, and a table over
  // it would drop the category-to-gate map that says which pair is legal.
  const res = await call(deps, scope, { path: "/api/governance/metadata" });
  writeRawResponse(deps.io, res.raw);
}

// --- the organisation's policy catalog --------------------------------------

interface PolicyRow {
  id: string;
  policyId: string;
  name: string;
  category: string;
  level: string;
  gateType: string;
  severity: string | null;
  immutable?: boolean;
  organizationId?: string | null;
}

function policiesPath(org: string, rest = ""): string {
  return orgPath(org, `/governance/policies${rest}`);
}

async function policyList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "governance policy list option");
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: policiesPath(org) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  // A bare array, not a wrapped one — the engine's policy catalog route answers
  // with the rows themselves.
  const policies = expectArray<PolicyRow>(res.body, `GET ${policiesPath(org)}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["POLICY ID", "NAME", "CATEGORY", "GATE", "SEVERITY", "BUILT IN"],
      rows: policies.map((policy) => [
        text(policy.policyId),
        text(policy.name),
        text(policy.category),
        text(policy.gateType),
        text(policy.severity),
        policy.organizationId === null ? "yes" : "no",
      ]),
      emptyMessage: `Organisation ${org} sees no governance policies.`,
    })}\n`,
  );
}

async function policyCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--file", "--confirm"] }, "governance policy create option");
  const file = takeValue(args, "--file");
  if (file === undefined) throw new ConfigError('polyant-cli governance policy create needs --file <path> (or --file - for stdin).');
  const body = parseObject(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);

  const policyId = typeof body.policyId === "string" ? body.policyId : undefined;
  if (policyId === undefined) throw new ConfigError("The policy payload needs a policyId.");
  // The engine reserves the built-in prefixes and answers 400. Saying so here
  // costs one comparison and names the fix.
  if (!policyId.startsWith("custom:")) {
    deps.io.stderr(`note: the engine reserves the built-in policy prefixes — a custom policy id normally starts with "custom:".\n`);
  }

  const { scope, org } = await readScope(deps, context);
  const plan = {
    title: `Create governance policy ${policyId} in ${org}`,
    changes: [`Add ${policyId} with keys: ${Object.keys(body).sort().join(", ")}.`, "Creating it does not assign it: use `agent governance set`."],
  };
  if (!(await preflight(deps, scope, org, context, args, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: policiesPath(org), body });
  report(deps, context, res.raw, `Created governance policy ${policyId}.`);
}

async function policyUpdate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const id = requirePositional(args, "governance policy update", "policy row id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--confirm"] }, "governance policy update option");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError('polyant-cli governance policy update needs --file <path> (or --file - for stdin).');
  const body = parseObject(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);

  const { scope, org } = await readScope(deps, context);
  const plan = { title: `Update governance policy ${id}`, changes: [`Patch keys: ${Object.keys(body).sort().join(", ")}.`] };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PATCH", path: policiesPath(org, `/${encodeURIComponent(id)}`), body });
  report(deps, context, res.raw, `Updated governance policy ${id}.`);
}

async function policyDelete(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const id = requirePositional(args, "governance policy delete", "policy row id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "governance policy delete option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Delete governance policy ${id}`,
    changes: [`Remove ${id} from ${org}'s catalog. Every agent it is assigned to stops being governed by it.`],
    destructive: { confirm: id },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: policiesPath(org, `/${encodeURIComponent(id)}`) });
  report(deps, context, res.raw, `Deleted governance policy ${id}.`);
}

export function parseObject(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${source} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export const governanceFamily: Record<string, Node> = {
  overview: {
    summary: "the governance posture of the addressed workspace",
    usage: "Usage: polyant-cli governance overview\n\nAnswers for the workspace the request addresses, not the whole organisation.",
    action: governanceOverview,
  },
  analytics: {
    summary: "governance activity over a period",
    usage: `Usage: polyant-cli governance analytics [--from <iso>] [--to <iso>] [--org]

Without --org this answers for the addressed workspace; with it, for every
workspace in the organisation. ${ORG_NOTE}`,
    action: governanceAnalytics,
  },
  tools: {
    summary: "the tools this organisation may govern",
    usage: "Usage: polyant-cli governance tools\n\nFiltered by the organisation's plugin grants: an ungranted plugin's tools are absent, not disabled.",
    action: governanceTools,
  },
  metadata: {
    summary: "the gate types, categories and severities a policy may name",
    usage: "Usage: polyant-cli governance metadata\n\nThe vocabulary for `governance policy create`, including which category each gate type belongs to.",
    action: governanceMetadata,
  },
  policy: {
    list: {
      summary: "list the organisation's governance policy catalog",
      usage: `Usage: polyant-cli governance policy list\n\nBuilt-in policies are visible to every organisation and marked as such. ${ORG_NOTE}`,
      action: policyList,
    },
    create: {
      summary: "create a governance policy from a JSON file or stdin",
      usage: `Usage: polyant-cli governance policy create --file <path|->

Needs policyId, name, category and gateType. Run \`governance metadata\` for the
legal values. Creating a policy does not assign it to anything. ${ORG_NOTE}`,
      action: policyCreate,
      mutates: true,
    },
    update: {
      summary: "patch a governance policy from a JSON file or stdin",
      usage: `Usage: polyant-cli governance policy update <id> --file <path|->\n\nThe id is the row id from \`policy list\`, not the policyId. ${ORG_NOTE}`,
      action: policyUpdate,
      mutates: true,
    },
    delete: {
      summary: "delete a governance policy",
      usage: `Usage: polyant-cli governance policy delete <id> --yes --confirm <id>\n\n${ORG_NOTE}`,
      action: policyDelete,
      mutates: true,
    },
  },
};
