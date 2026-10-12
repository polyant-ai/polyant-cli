// SPDX-License-Identifier: Apache-2.0
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { credentialKind } from "../runtime/credential.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { ORG_NOTE, orgPath, preflight as orgPreflight, readScope, report, requirePositional } from "../runtime/org.js";
import { call, expectArray, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { ResolvedScope } from "../runtime/scope.js";
import type { Node } from "../runtime/tree.js";
import { agentPath, preflight, reportWrite, requireSecond, requireSlug } from "../runtime/workspace.js";
import { assertCredentialShape, connectionTable, readCredentials, type ConnectionRow, type CredentialShape } from "./providers.js";

/**
 * Credential roles (engine 1.2.0-ee).
 *
 * Every use of a provider credential is a ROLE — an agent's `chat`, `embedding`,
 * `stt` and the voice roles, an organisation's `library_embedding` — and each
 * role is bound to exactly one connection. Provider keys stored as secrets are
 * read for none of them any more, and the secret routes refuse to write them.
 *
 * The role names are the engine's, read from it on every call: a plugin can
 * register a role at boot, so a list here would refuse one the engine accepts.
 *
 * An agent may also own connections of its own ("private"), the replacement for
 * the provider keys it used to carry as secrets. Each is flagged `usable`: false
 * in an organisation that accepts only its own connections, where one made
 * before the switch can only be deleted.
 */

interface RoleReadiness {
  ready?: boolean;
  problem?: string | null;
  message?: string | null;
}

interface RoleOption {
  id: string;
  name: string;
  provider: string;
  private?: boolean;
}

interface RoleView {
  role: string;
  capability?: string;
  requiredProvider?: string | null;
  /** Agent roles only: whether the agent's current settings use this role. */
  inUse?: boolean;
  connectionId: string | null;
  /**
   * Agent roles only: the bound connection while the agent can still reach it,
   * also when it no longer fits the role, so the reader sees what is bound.
   */
  connection?: RoleOption | null;
  readiness?: RoleReadiness;
  options?: RoleOption[];
}

/** A private connection as the agent's listings report it. */
interface PrivateConnectionRow extends ConnectionRow {
  /** False under managed-only: no role can use it, and it can only be deleted. */
  usable?: boolean;
}

interface AgentRolesBody {
  roles?: unknown;
  privateConnections?: unknown;
  privateConnectionsAllowed?: unknown;
  ambientAwsGranted?: unknown;
  credentialShapes?: Record<string, CredentialShape>;
  capabilities?: Record<string, string[]>;
}

function agentRolesPath(slug: string, role?: string): string {
  return agentPath(slug, role === undefined ? "/provider-roles" : `/provider-roles/${encodeURIComponent(role)}`);
}

function agentConnectionsPath(slug: string, id?: string): string {
  return agentPath(slug, id === undefined ? "/provider-connections" : `/provider-connections/${encodeURIComponent(id)}`);
}

function orgRolesPath(org: string, role?: string): string {
  return orgPath(org, role === undefined ? "/providers/roles" : `/providers/roles/${encodeURIComponent(role)}`);
}

function ambientAwsPath(org: string): string {
  return `/api/platform/organizations/${encodeURIComponent(org)}/ambient-aws`;
}

/**
 * The bound connection by name. The engine names it in `connection` while the
 * agent can reach it, whether or not it still fits the role; an organisation
 * role is named from its options. Else the id: an unreachable binding is still
 * a binding.
 */
function boundLabel(view: RoleView): string {
  if (view.connectionId === null) return "(unbound)";
  const named = view.connection ?? (view.options ?? []).find((candidate) => candidate.id === view.connectionId);
  return named === undefined || named === null ? view.connectionId : `${named.name} (${named.provider})`;
}

function readyCell(view: RoleView): string {
  return view.readiness?.ready === true ? "yes" : view.readiness?.ready === false ? "no" : "-";
}

function rolesTable(roles: readonly RoleView[], withInUse: boolean, empty: string): string {
  return renderTable({
    headers: withInUse ? ["ROLE", "IN USE", "BOUND TO", "READY", "NEEDS"] : ["ROLE", "BOUND TO", "READY", "NEEDS"],
    rows: roles.map((view) => {
      // What the bound connection must be able to do, and on which provider when the owner chose one.
      const needs = view.requiredProvider ? `${text(view.capability)} on ${view.requiredProvider}` : text(view.capability);
      const cells = [view.role, boundLabel(view), readyCell(view), needs];
      return withInUse ? [cells[0], view.inUse === true ? "yes" : "no", ...cells.slice(1)] : cells;
    }),
    emptyMessage: empty,
  });
}

/**
 * The resolver's own sentence for each role that cannot run. For an agent, only
 * the roles it uses: an unused voice role with no binding is not a problem.
 */
function writeProblems(deps: ServiceDependencies, roles: readonly RoleView[], agent: boolean): void {
  const problems = roles.filter((view) => view.readiness?.ready === false && (!agent || view.inUse === true));
  if (problems.length === 0) return;
  deps.io.stdout(`\n${problems.map((view) => `${view.role}: ${text(view.readiness?.message ?? view.readiness?.problem)}`).join("\n")}\n`);
}

function optionsTable(roles: readonly RoleView[], withPrivate: boolean, empty: string): string {
  const rows = roles.flatMap((view) =>
    (view.options ?? []).map((option) => {
      const cells = [view.role, text(option.id), text(option.name), text(option.provider)];
      return withPrivate ? [...cells, option.private === true ? "yes" : "no"] : cells;
    }),
  );
  return renderTable({
    headers: withPrivate ? ["ROLE", "CONNECTION", "NAME", "PROVIDER", "PRIVATE"] : ["ROLE", "CONNECTION", "NAME", "PROVIDER"],
    rows,
    emptyMessage: empty,
  });
}

async function agentRolesOf(deps: ServiceDependencies, scope: ResolvedScope, slug: string): Promise<{ body: AgentRolesBody; roles: RoleView[]; raw: string }> {
  const path = agentRolesPath(slug);
  const res = await call(deps, scope, { path });
  const body = (res.body ?? {}) as AgentRolesBody;
  return { body, roles: expectArray<RoleView>(body.roles, `GET ${path}`), raw: res.raw };
}

function findRole(roles: readonly RoleView[], role: string, owner: string): RoleView {
  const found = roles.find((view) => view.role === role);
  if (found !== undefined) return found;
  throw new ConfigError(`${owner} has no role ${JSON.stringify(role)}. Roles: ${roles.map((view) => view.role).join(", ") || "(none)"}.`);
}

function assertOption(view: RoleView, connectionId: string, owner: string): RoleOption {
  const option = (view.options ?? []).find((candidate) => candidate.id === connectionId);
  if (option !== undefined) return option;
  // The options are the engine's, filtered by the same test its binding
  // applies: reachable here, able to serve the role, and for the provider the
  // owner chose for it. Anything outside them would be refused.
  const offered = (view.options ?? []).map((candidate) => `${candidate.id} (${candidate.name}, ${candidate.provider})`);
  const fit = view.requiredProvider ? `${text(view.capability)} on ${view.requiredProvider}` : text(view.capability);
  throw new ConfigError(
    `Connection ${JSON.stringify(connectionId)} is not one ${owner}'s ${view.role} role may take: it is not reachable there, ` +
      `or it cannot serve ${fit}. It may take: ${offered.join(", ") || "(none)"}.`,
  );
}

// --- agent roles ---------------------------------------------------------------

async function agentRolesShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "provider-roles show");
  assertKnown(args.slice(1), {}, "agent provider-roles show option");
  const scope = await scopeFor(deps, context, "read");
  const { body, roles, raw } = await agentRolesOf(deps, scope, slug);
  if (wantsJson(context)) return writeRawResponse(deps.io, raw);

  deps.io.stdout(`${rolesTable(roles, true, `Agent ${slug} has no credential roles.`)}\n`);
  writeProblems(deps, roles, true);
  deps.io.stdout(`\n${optionsTable(roles, true, `No connection is available to agent ${slug}'s roles.`)}\n\n`);
  writePrettyResource(deps.io, [
    // False in an organisation that accepts only the connections it prepares.
    { label: "private connections allowed", value: body.privateConnectionsAllowed === true ? "yes" : "no" },
    { label: "ambient AWS identity", value: body.ambientAwsGranted === true ? "granted" : "not granted" },
  ]);
}

async function agentRoleBind(args: string[], context: CommandContext | undefined, deps: ServiceDependencies, bind: boolean): Promise<void> {
  const action = bind ? "provider-roles bind" : "provider-roles unbind";
  const slug = requireSlug(args, action);
  const role = requireSecond(args, action, "role");
  const connectionId = bind ? requirePositional(args.slice(2), `agent ${action}`, "connection id") : null;
  const options = args.slice(bind ? 3 : 2);
  assertKnown(options, { value: ["--confirm"] }, `agent ${action} option`);

  const scope = await scopeFor(deps, context);
  // Read first: the recap names what the role is bound to now, and an unknown
  // role or an unreachable connection fails naming the ones that exist.
  const { roles } = await agentRolesOf(deps, scope, slug);
  const view = findRole(roles, role, `Agent ${slug}`);
  const option = connectionId === null ? undefined : assertOption(view, connectionId, `agent ${slug}`);

  const plan = bind
    ? {
        title: `Bind ${slug}'s ${role} role`,
        changes: [
          view.connectionId === connectionId
            ? `Leave ${role} bound to ${boundLabel(view)}.`
            : `Bind ${role} to ${option?.name} (${option?.provider}${option?.private === true ? ", private to the agent" : ""}), replacing ${boundLabel(view)}.`,
          `The agent's ${role} authenticates with that connection from its next use. Values are never shown.`,
        ],
      }
    : {
        title: `Unbind ${slug}'s ${role} role`,
        changes: [
          `Clear ${role}, bound to ${boundLabel(view)}.`,
          view.inUse === true
            ? `The agent uses ${role}: it stops at the next use rather than falling back to another credential.`
            : `The agent does not use ${role} now; it will stop when its settings start using it.`,
        ],
        destructive: { confirm: role },
      };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PUT", path: agentRolesPath(slug, role), body: { connectionId } });
  // The engine answers with the roles after the write: a binding it accepted can
  // still fail to resolve (an incomplete Bedrock credential, a revoked grant).
  const after = expectArray<RoleView>((res.body as AgentRolesBody | null)?.roles ?? [], `PUT ${agentRolesPath(slug, role)}`).find(
    (candidate) => candidate.role === role,
  );
  if (bind && after?.readiness?.ready === false) {
    deps.io.stderr(`warning: ${role} is bound but cannot run yet: ${text(after.readiness.message ?? after.readiness.problem)}\n`);
  }
  reportWrite(deps, context, res, bind ? `Bound ${slug}'s ${role} role to ${option?.name ?? connectionId}.` : `Unbound ${slug}'s ${role} role.`);
}

// --- agent private connections -------------------------------------------------

async function agentConnectionsList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "connections list");
  assertKnown(args.slice(1), {}, "agent connections list option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentConnectionsPath(slug);
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const connections = expectArray<PrivateConnectionRow>((res.body as { connections?: unknown } | null)?.connections, `GET ${path}`);
  // Which roles each one serves, from the role read: a bound connection cannot be deleted.
  const { roles } = await agentRolesOf(deps, scope, slug);
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "NAME", "PROVIDER", "FIELDS", "USABLE", "BOUND TO"],
      rows: connections.map((connection) => [
        text(connection.id),
        text(connection.name),
        text(connection.provider),
        (connection.configuredFields ?? []).join(", ") || "-",
        connection.usable === true ? "yes" : connection.usable === false ? "no" : "-",
        roles.filter((view) => view.connectionId === connection.id).map((view) => view.role).join(", ") || "-",
      ]),
      emptyMessage: `Agent ${slug} has no private provider connections.`,
    })}\n`,
  );
  if (connections.some((connection) => connection.usable === false)) {
    deps.io.stderr(
      `note: agent ${slug}'s organisation accepts only the connections it prepares, so no role can use a connection marked ` +
        "USABLE no; it can only be deleted.\n",
    );
  }
}

async function agentConnectionsCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "connections create");
  const name = requireSecond(args, "connections create", "connection name");
  const options = args.slice(2);
  assertKnown(options, { value: ["--provider", "--file", "--confirm"] }, "agent connections create option");
  const provider = takeValue(options, "--provider");
  if (provider === undefined) throw new ConfigError("polyant-cli agent connections create needs --provider <name>.");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError("polyant-cli agent connections create needs --file <path> (or --file - for stdin).");

  const credentials = await readCredentials(deps, file);
  const scope = await scopeFor(deps, context);
  const { body } = await agentRolesOf(deps, scope, slug);
  if (body.privateConnectionsAllowed === false) {
    throw new ConfigError(
      `Agent ${slug}'s organisation accepts only the connections it prepares, so the agent cannot have one of its own. ` +
        "Create it with `org connections create`, lend it with `workspace connections assign`, then bind the role.",
    );
  }
  // The agent's shapes: narrowed to what its workspace admits, and with
  // Bedrock's region-only mode only under the ambient AWS grant.
  assertCredentialShape(body.credentialShapes, provider, credentials);
  const capabilities = body.capabilities?.[provider];

  const plan = {
    title: `Create a private provider connection on ${slug}`,
    changes: [
      `Add a ${provider} credential named ${JSON.stringify(name)}, usable by agent ${slug} alone.`,
      `Fields: ${Object.keys(credentials).sort().join(", ")}. Values are never printed.`,
      ...(capabilities === undefined ? [] : [`It can serve roles needing: ${capabilities.join(", ") || "(nothing)"}.`]),
      `Nothing uses it until a role is bound to it: \`agent provider-roles bind ${slug} <role> <connectionId>\`.`,
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: agentConnectionsPath(slug), body: { name, provider, credentials } });
  const id = (res.body as { id?: unknown } | null)?.id;
  reportWrite(deps, context, res, `Created private provider connection ${name}${typeof id === "string" ? ` (${id})` : ""} on ${slug}.`);
}

async function agentConnectionsUpdate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "connections update");
  const id = requireSecond(args, "connections update", "connection id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--name", "--file", "--confirm"] }, "agent connections update option");
  const name = takeValue(options, "--name");
  const file = takeValue(options, "--file");
  if (name === undefined && file === undefined) {
    throw new ConfigError("polyant-cli agent connections update needs --name <name> or --file <path|-> (or both).");
  }

  const credentials = file === undefined ? undefined : await readCredentials(deps, file);
  const scope = await scopeFor(deps, context);
  // The PATCH is checked against the connection's OWN provider, which the id
  // does not carry, and a wrong id fails naming the agent instead of as a 404.
  const { body, roles } = await agentRolesOf(deps, scope, slug);
  const connections = Array.isArray(body.privateConnections) ? (body.privateConnections as PrivateConnectionRow[]) : [];
  const existing = connections.find((connection) => connection.id === id);
  if (existing === undefined) throw new ConfigError(`Agent ${slug} has no private provider connection ${JSON.stringify(id)}.`);
  if (credentials !== undefined) assertCredentialShape(body.credentialShapes, existing.provider, credentials);
  const boundRoles = roles.filter((view) => view.connectionId === id).map((view) => view.role);

  const plan = {
    title: `Update private provider connection ${existing.name} on ${slug}`,
    changes: [
      ...(name === undefined ? [] : [`Rename it to ${JSON.stringify(name)}.`]),
      ...(existing.usable === false
        ? ["The organisation accepts only the connections it prepares: no role can use this one, whatever it holds."]
        : []),
      ...(credentials === undefined
        ? []
        : [
            `Replace the ${existing.provider} credential with fields ${Object.keys(credentials).sort().join(", ")}.`,
            boundRoles.length === 0
              ? "No role is bound to it yet."
              : `${boundRoles.join(", ")} authenticate${boundRoles.length === 1 ? "s" : ""} with the new value from the next use.`,
          ]),
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "PATCH",
    path: agentConnectionsPath(slug, id),
    body: { ...(name === undefined ? {} : { name }), ...(credentials === undefined ? {} : { credentials }) },
  });
  reportWrite(deps, context, res, `Updated private provider connection ${existing.name} on ${slug}.`);
}

async function agentConnectionsDelete(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "connections delete");
  const id = requireSecond(args, "connections delete", "connection id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent connections delete option");
  const scope = await scopeFor(deps, context);

  const plan = {
    title: `Delete private provider connection ${id} from ${slug}`,
    changes: [
      `Remove the credential from agent ${slug}.`,
      // A NO ACTION foreign key on the binding: the engine answers 409.
      "The engine refuses while one of the agent's roles is bound to it: bind that role elsewhere first. " +
        "Allowed in an organisation that accepts only its own connections.",
    ],
    destructive: { confirm: id },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: agentConnectionsPath(slug, id) });
  reportWrite(deps, context, res, `Deleted private provider connection ${id} from ${slug}.`);
}

// --- organisation roles --------------------------------------------------------

async function orgRolesOf(deps: ServiceDependencies, scope: ResolvedScope, org: string): Promise<{ roles: RoleView[]; raw: string }> {
  const path = orgRolesPath(org);
  const res = await call(deps, scope, { path });
  return { roles: expectArray<RoleView>((res.body as { roles?: unknown } | null)?.roles, `GET ${path}`), raw: res.raw };
}

async function orgRolesShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "org provider-roles show option");
  const { scope, org } = await readScope(deps, context);
  const { roles, raw } = await orgRolesOf(deps, scope, org);
  if (wantsJson(context)) return writeRawResponse(deps.io, raw);

  deps.io.stdout(`${rolesTable(roles, false, `Organisation ${org} has no credential roles.`)}\n`);
  writeProblems(deps, roles, false);
  deps.io.stdout(`\n${optionsTable(roles, false, `None of ${org}'s connections can serve its roles.`)}\n`);
}

async function orgRoleBind(args: string[], context: CommandContext | undefined, deps: ServiceDependencies, bind: boolean): Promise<void> {
  const action = bind ? "org provider-roles bind" : "org provider-roles unbind";
  const role = requirePositional(args, action, "role");
  const connectionId = bind ? requirePositional(args.slice(1), action, "connection id") : null;
  const options = args.slice(bind ? 2 : 1);
  assertKnown(options, { value: ["--confirm"] }, `${action} option`);

  const { scope, org } = await readScope(deps, context);
  const { roles } = await orgRolesOf(deps, scope, org);
  const view = findRole(roles, role, `Organisation ${org}`);
  const option = connectionId === null ? undefined : assertOption(view, connectionId, `organisation ${org}`);

  const plan = bind
    ? {
        title: `Bind ${org}'s ${role} role`,
        changes: [
          view.connectionId === connectionId
            ? `Leave ${role} bound to ${boundLabel(view)}.`
            : `Bind ${role} to ${option?.name} (${option?.provider}), replacing ${boundLabel(view)}.`,
          "A connection serving a workspace's library must also be lent to that workspace.",
        ],
      }
    : {
        title: `Unbind ${org}'s ${role} role`,
        changes: [`Clear ${role}, bound to ${boundLabel(view)}. What uses it stops rather than falling back to another credential.`],
        destructive: { confirm: role },
      };
  if (!(await orgPreflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PUT", path: orgRolesPath(org, role), body: { connectionId } });
  const after = expectArray<RoleView>((res.body as { roles?: unknown } | null)?.roles ?? [], `PUT ${orgRolesPath(org, role)}`).find(
    (candidate) => candidate.role === role,
  );
  if (bind && after?.readiness?.ready === false) {
    deps.io.stderr(`warning: ${role} is bound but cannot run yet: ${text(after.readiness.message ?? after.readiness.problem)}\n`);
  }
  report(deps, context, res.raw, bind ? `Bound ${org}'s ${role} role to ${option?.name ?? connectionId}.` : `Unbound ${org}'s ${role} role.`);
}

// --- the platform's ambient AWS grant -------------------------------------------

/**
 * `@PlatformAdminOnly()` admits only a human principal: a Platform Admin's
 * personal token reaches it, a management key never does, whatever it holds.
 * Refused here, before any request, naming what works.
 */
function platformScope(scope: ResolvedScope, action: string): void {
  if (credentialKind(scope.target.key) !== "management-key") return;
  throw new ConfigError(
    `polyant-cli ${action} needs a Platform Admin's personal token (pat_): the engine admits only a person on /api/platform, ` +
      "never a management key.",
  );
}

async function ambientAws(args: string[], context: CommandContext | undefined, deps: ServiceDependencies, mode: "show" | "grant" | "revoke"): Promise<void> {
  const action = `org ambient-aws ${mode}`;
  const org = requirePositional(args, action, "organisation slug");
  const options = args.slice(1);
  assertKnown(options, mode === "show" ? {} : { value: ["--confirm"] }, `${action} option`);
  const scope = await scopeFor(deps, context, "target");
  platformScope(scope, action);

  if (mode === "show") {
    const res = await call(deps, scope, { path: ambientAwsPath(org) });
    if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);
    const granted = (res.body as { granted?: unknown } | null)?.granted === true;
    deps.io.stdout(`Organisation ${org} ${granted ? "may" : "may not"} use the deployment's AWS identity for Bedrock.\n`);
    return;
  }

  const grant = mode === "grant";
  const plan = grant
    ? {
        title: `Grant ${org} the deployment's AWS identity`,
        changes: [
          `A Bedrock connection in ${org} may hold a region alone and sign with the deployment's own AWS identity.`,
          "Those calls are billed to the deployment's AWS account. The grant is recorded in the management audit.",
        ],
      }
    : {
        title: `Revoke ${org}'s use of the deployment's AWS identity`,
        changes: [
          `A Bedrock connection in ${org} holding a region and no key stops authenticating, and the roles bound to it stop at their next use.`,
          "Connections with a Bedrock API key or an access-key pair are unaffected.",
        ],
        destructive: { confirm: org },
      };
  if (!(await orgPreflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: grant ? "PUT" : "DELETE", path: ambientAwsPath(org) });
  report(deps, context, res.raw, grant ? `Granted ${org} the deployment's AWS identity.` : `Revoked ${org}'s use of the deployment's AWS identity.`);
}

// --- the trees -----------------------------------------------------------------

const ROLES_NOTE = `A role is one use of a provider credential, bound to exactly one connection.
Since engine 1.2.0-ee nothing reads a provider key stored as a secret: a role
with no binding stops rather than falling back to another credential.`;

/** `agent provider-roles`. */
export const agentProviderRolesFamily: Record<string, Node> = {
  show: {
    summary: "each credential role, the connection it is bound to, and whether it can run",
    usage: `Usage: polyant-cli agent provider-roles show <slug>

One row per role the engine knows for an agent — chat, embedding, stt and the
voice roles, plus any a plugin registers. IN USE says whether the agent's current
settings use it; NEEDS is the capability the connection must have, and the
provider when the agent chose one. A role it uses that cannot run is followed by
the engine's own reason. Underneath, the connections each role may be bound to:
lent to the agent's workspace, or private to the agent. ${ROLES_NOTE}`,
    action: agentRolesShow,
  },
  bind: {
    summary: "bind one of the agent's roles to a connection",
    usage: `Usage: polyant-cli agent provider-roles bind <slug> <role> <connectionId>

The connection must be one \`provider-roles show\` lists for that role; anything
else is refused before the write. The engine filters that list by the test the
binding applies — reachable by the agent, able to serve the role, and for the
provider the agent runs the role on — so a connection it offers is not refused
for its provider. \`agent update --provider-connection\` is gone. Needs
agent:write.`,
    action: (args, context, deps) => agentRoleBind(args, context, deps, true),
    mutates: true,
  },
  unbind: {
    summary: "clear one of the agent's role bindings",
    usage: `Usage: polyant-cli agent provider-roles unbind <slug> <role> --yes --confirm <role>

A role the agent uses stops at its next use: there is no fallback.`,
    action: (args, context, deps) => agentRoleBind(args, context, deps, false),
    mutates: true,
  },
};

/** `agent connections`. */
export const agentConnectionsFamily: Record<string, Node> = {
  list: {
    summary: "list the provider connections private to an agent",
    usage: `Usage: polyant-cli agent connections list <slug>

Names, providers, which fields are populated, whether a role may use each, and
which roles are bound to each. The engine serves no value, so neither does this.
In an organisation that accepts only its own connections a private connection
made before the switch is still listed, marked USABLE no, so it can be found and
deleted.`,
    action: agentConnectionsList,
  },
  create: {
    summary: "create a provider connection only this agent may use",
    usage: `Usage: polyant-cli agent connections create <slug> <name> --provider <name> --file <path|->

The replacement for the provider keys an agent used to carry as secrets. The file
is a JSON object of credential fields, for example {"api_key": "..."}, read from
a file or stdin, never a flag, and never printed; the fields are checked against
the shape the engine reports for the agent first. A Bedrock connection holding a
region alone needs the organisation's ambient AWS grant. Refused in an
organisation that accepts only its own connections. Nothing uses the connection
until a role is bound to it. Needs agent.secret:write.`,
    action: agentConnectionsCreate,
    mutates: true,
  },
  update: {
    summary: "rename an agent's private connection, or rotate its credential",
    usage: `Usage: polyant-cli agent connections update <slug> <connectionId> [--name <name>] [--file <path|->]

--file REPLACES the credential; every role bound to it authenticates with the new
value from its next use.`,
    action: agentConnectionsUpdate,
    mutates: true,
  },
  delete: {
    summary: "delete an agent's private connection",
    usage: `Usage: polyant-cli agent connections delete <slug> <connectionId> --yes --confirm <connectionId>

The engine refuses with a 409 while one of the agent's roles is bound to it. A
connection no role may use under managed-only can still be deleted.`,
    action: agentConnectionsDelete,
    mutates: true,
  },
};

/** `org provider-roles` and `org ambient-aws`, merged into the `org` family in admin.ts. */
export const PROVIDER_ROLE_FAMILY_EXTRAS: Record<string, Record<string, Node>> = {
  org: {
    "provider-roles": {
      show: {
        summary: "the organisation's credential roles and the connection each is bound to",
        usage: `Usage: polyant-cli org provider-roles show

Today one role, library_embedding: the embedder the shared knowledge libraries
are indexed with. Needs org.secret:read. ${ROLES_NOTE} ${ORG_NOTE}`,
        action: orgRolesShow,
      },
      bind: {
        summary: "bind one of the organisation's roles to one of its connections",
        usage: `Usage: polyant-cli org provider-roles bind <role> <connectionId>

Only the organisation's own connections are offered. A workspace's library uses
the binding only when the connection is lent to that workspace. Needs
org.secret:write. ${ORG_NOTE}`,
        action: (args, context, deps) => orgRoleBind(args, context, deps, true),
        mutates: true,
      },
      unbind: {
        summary: "clear one of the organisation's role bindings",
        usage: `Usage: polyant-cli org provider-roles unbind <role> --yes --confirm <role>

${ORG_NOTE}`,
        action: (args, context, deps) => orgRoleBind(args, context, deps, false),
        mutates: true,
      },
    },
    "ambient-aws": {
      show: {
        summary: "whether an organisation may use the deployment's AWS identity (Platform Admin)",
        usage: `Usage: polyant-cli org ambient-aws show <orgSlug>

With the grant, a Bedrock connection may hold a region alone and sign with the
deployment's own AWS identity; without it, it needs a Bedrock API key or an
access-key pair. Platform Admin only: needs a Platform Admin's personal token
(pat_), which a management key never is. The organisation is named, not taken
from the key, because a Platform Admin acts on organisations it does not belong to.`,
        action: (args, context, deps) => ambientAws(args, context, deps, "show"),
      },
      grant: {
        summary: "let an organisation use the deployment's AWS identity (Platform Admin)",
        usage: `Usage: polyant-cli org ambient-aws grant <orgSlug>

Lends the deployment's identity, and its AWS bill, to the organisation. Recorded
in the management audit. Platform Admin personal token only.`,
        action: (args, context, deps) => ambientAws(args, context, deps, "grant"),
        mutates: true,
      },
      revoke: {
        summary: "withdraw an organisation's use of the deployment's AWS identity (Platform Admin)",
        usage: `Usage: polyant-cli org ambient-aws revoke <orgSlug> --yes --confirm <orgSlug>

A region-only Bedrock connection in that organisation stops authenticating, so
the roles bound to it stop at their next use; every replica sees the revocation
within 30 seconds. Platform Admin personal token only.`,
        action: (args, context, deps) => ambientAws(args, context, deps, "revoke"),
        mutates: true,
      },
    },
  },
};
