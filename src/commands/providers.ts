// SPDX-License-Identifier: Apache-2.0
import type { CommandContext } from "../command.js";
import { ConfigError, RemoteError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { ORG_NOTE, orgPath, preflight, readScope, report, requirePositional } from "../runtime/org.js";
import { call, expectArray, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import { agentPath, requireSlug } from "../runtime/workspace.js";
import type { ResolvedScope } from "../runtime/scope.js";
import type { Node } from "../runtime/tree.js";
import { parseObject } from "./governance.js";

/**
 * Which models a tenant may run, and the named credentials it runs them with.
 *
 * Two orthogonal decisions, kept apart here because the engine keeps them apart:
 *
 * - ADMISSIBILITY. The platform admits a provider to an organisation, the
 *   organisation admits it to a workspace, and an agent needs both. Within an
 *   admitted provider individual models are switched OFF, never on, so a
 *   catalogue refresh reaches the tenant that paid for it.
 * - CONNECTIONS. A named credential owned by the organisation and lent to
 *   workspaces, so whoever builds an agent picks by name and never sees the key.
 *
 * The outer half — admitting a provider to the ORGANISATION — is a platform-admin
 * decision and lives only on `/api/platform/...`, which a management key cannot
 * reach. `org providers show` therefore reports it and cannot change it, the same
 * way `org plugins` reports a grant it cannot make.
 *
 * Since engine 1.2.0-ee a connection is the only place a provider key lives:
 * each use of one is a role bound to a connection (`provider-roles.ts`), and the
 * secret routes refuse provider keys. The upgrade carried an organisation's
 * provider secrets into one connection lent to every workspace.
 */

export interface ConnectionRow {
  id: string;
  name: string;
  provider: string;
  /** Which credential fields are populated. Never a value — the engine serves none. */
  configuredFields: string[];
  /** Only on the workspace read: whether this workspace may use it. */
  assigned?: boolean;
}

export interface CredentialShape {
  fields: string[];
  /** Each entry is one complete set of fields that authenticates on its own. */
  accepts: string[][];
  alsoRequired?: string[];
}

interface OrgProvidersBody {
  providers?: unknown;
  /** `provider/modelId` pairs switched off at the organisation tier. */
  disabledModels?: unknown;
  connections?: unknown;
  managedConnectionsOnly?: unknown;
  /** 1.2.0-ee: whether a Bedrock connection may sign with the deployment's AWS identity. */
  ambientAwsGranted?: unknown;
  credentialShapes?: Record<string, CredentialShape>;
  /** 1.2.0-ee: each provider a connection can be for, and what it can do. */
  catalog?: unknown;
}

function connectionsPath(org: string, id?: string): string {
  return orgPath(org, id === undefined ? "/provider-connections" : `/provider-connections/${encodeURIComponent(id)}`);
}

function workspacePath(org: string, workspace: string, rest: string): string {
  return orgPath(org, `/workspaces/${encodeURIComponent(workspace)}${rest}`);
}

export function connectionTable(connections: readonly ConnectionRow[], empty: string, withAssigned: boolean): string {
  return renderTable({
    headers: withAssigned ? ["ID", "NAME", "PROVIDER", "FIELDS", "ASSIGNED"] : ["ID", "NAME", "PROVIDER", "FIELDS"],
    rows: connections.map((connection) => {
      const cells = [
        text(connection.id),
        text(connection.name),
        text(connection.provider),
        // The field NAMES, which is the whole of what the engine discloses: it
        // is enough to tell an incomplete Bedrock credential from a complete one.
        (connection.configuredFields ?? []).join(", ") || "-",
      ];
      return withAssigned ? [...cells, connection.assigned === true ? "yes" : "no"] : cells;
    }),
    emptyMessage: empty,
  });
}

async function orgProvidersShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "org providers show option");
  const { scope, org } = await readScope(deps, context);
  const path = orgPath(org, "/providers");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as OrgProvidersBody;
  const providers = expectArray<string>(body.providers, `GET ${path}`);
  const disabled = Array.isArray(body.disabledModels) ? (body.disabledModels as string[]) : [];
  const connections = Array.isArray(body.connections) ? (body.connections as ConnectionRow[]) : [];

  writePrettyResource(deps.io, [
    { label: "admitted providers", value: providers.length === 0 ? "(none)" : providers.join(", ") },
    // Models are switched off, never on, so this list IS the organisation's
    // model policy: everything else the catalogue offers is available.
    { label: "models switched off", value: disabled.length === 0 ? "(none)" : disabled.join(", ") },
    { label: "managed connections only", value: body.managedConnectionsOnly === true ? "yes" : "no" },
    // Granted by a Platform Admin (`org ambient-aws`): a region-only Bedrock connection works only with it.
    { label: "ambient AWS identity", value: body.ambientAwsGranted === true ? "granted" : "not granted" },
  ]);
  deps.io.stdout(`\n${connectionTable(connections, `Organisation ${org} has no named provider connections.`, false)}\n`);
  // What a connection may be for: the admitted chat and embedding providers and
  // the speech services no admission governs, with the capabilities a role needs.
  const catalog = Array.isArray(body.catalog) ? (body.catalog as { provider?: unknown; capabilities?: unknown }[]) : [];
  if (catalog.length > 0) {
    deps.io.stdout(
      `\n${renderTable({
        headers: ["PROVIDER", "CAN SERVE"],
        rows: catalog.map((entry) => [text(entry.provider), Array.isArray(entry.capabilities) ? entry.capabilities.join(", ") : "-"]),
      })}\n`,
    );
  }
}

async function managedOnly(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--confirm"], boolean: ["--on", "--off"] }, "org providers managed-only option");
  const on = args.includes("--on");
  if (on === args.includes("--off")) throw new ConfigError("polyant-cli org providers managed-only needs --on or --off.");

  const { scope, org } = await readScope(deps, context);
  const plan = {
    title: `Turn managed connections ${on ? "on" : "off"} for ${org}`,
    changes: [
      on
        ? "Agents may use only the organisation's connections. A role bound to a connection private to an agent STOPS at its next use, and no agent may create one."
        : "Agents may have provider connections of their own again.",
    ],
  };
  if (!(await preflight(deps, scope, org, context, args, plan))) return;

  const res = await call(deps, scope, { method: "PUT", path: orgPath(org, "/providers/managed-only"), body: { managedOnly: on } });
  report(deps, context, res.raw, `Managed connections are now ${on ? "required" : "optional"} in ${org}.`);
}

async function connectionsList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "org connections list option");
  const { scope, org } = await readScope(deps, context);
  const path = connectionsPath(org);
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const connections = expectArray<ConnectionRow>((res.body as { connections?: unknown } | null)?.connections, `GET ${path}`);
  deps.io.stdout(`${connectionTable(connections, `Organisation ${org} has no named provider connections.`, false)}\n`);
}

/**
 * Credentials arrive as a JSON object from a file or stdin, never as flags: the
 * values are the keys themselves, and a flag lands in shell history and in `ps`.
 */
export async function readCredentials(deps: ServiceDependencies, file: string): Promise<Record<string, string>> {
  const parsed = parseObject(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);
  const credentials: Record<string, string> = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new ConfigError(`Credential field ${JSON.stringify(field)} must be a non-empty string.`);
    }
    credentials[field] = value;
  }
  if (Object.keys(credentials).length === 0) throw new ConfigError(`${file === "-" ? "stdin" : file} carried no credential fields.`);
  return credentials;
}

/**
 * The shapes travel with the organisation read, so this is a check against what
 * the engine itself will apply rather than a second copy of the rule. A
 * mistyped field would otherwise come back as a 400 naming a Zod path.
 */
export function assertCredentialShape(shapes: Record<string, CredentialShape> | undefined, provider: string, credentials: Record<string, string>): void {
  const shape = shapes?.[provider];
  if (shape === undefined) {
    // An unknown provider is the engine's decision to make: it holds the
    // catalogue, and a CLI that guessed would refuse a provider added upstream.
    return;
  }
  const present = Object.keys(credentials);
  const unknown = present.filter((field) => !shape.fields.includes(field));
  if (unknown.length > 0) {
    throw new ConfigError(`Provider ${provider} takes ${shape.fields.join(", ")}; it has no field ${unknown.sort().join(", ")}.`);
  }
  const complete = shape.accepts.some((mode) => mode.every((field) => present.includes(field)));
  const extras = (shape.alsoRequired ?? []).every((field) => present.includes(field));
  if (!complete || !extras) {
    const modes = shape.accepts.map((mode) => mode.join(" + ")).join(", or ");
    const also = (shape.alsoRequired ?? []).length === 0 ? "" : `, plus ${(shape.alsoRequired ?? []).join(", ")}`;
    throw new ConfigError(`Provider ${provider} needs ${modes}${also}; got ${present.sort().join(", ")}.`);
  }
}

/**
 * A check before a write that the write itself does not need. Create and update
 * take `org.secret:write`; the reads behind these checks take `org.secret:read`,
 * which a write-only key does not hold. Such a key gets `undefined` and a note,
 * and the engine's own validation is what stands.
 */
async function readIfAllowed<T>(deps: ServiceDependencies, read: () => Promise<T>, skipped: string): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof RemoteError && error.status === 403)) throw error;
    deps.io.stderr(`note: this key lacks org.secret:read, so ${skipped}; the engine validates the write itself.\n`);
    return undefined;
  }
}

async function credentialShapes(deps: ServiceDependencies, scope: ResolvedScope, org: string): Promise<Record<string, CredentialShape> | undefined> {
  const res = await call(deps, scope, { path: orgPath(org, "/providers") });
  return (res.body as OrgProvidersBody | null)?.credentialShapes;
}

async function connectionsCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const name = requirePositional(args, "org connections create", "connection name");
  const options = args.slice(1);
  assertKnown(options, { value: ["--provider", "--file", "--confirm"] }, "org connections create option");
  const provider = takeValue(options, "--provider");
  if (provider === undefined) throw new ConfigError("polyant-cli org connections create needs --provider <name>.");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError("polyant-cli org connections create needs --file <path> (or --file - for stdin).");

  const credentials = await readCredentials(deps, file);
  const { scope, org } = await readScope(deps, context);
  const shapes = await readIfAllowed(deps, () => credentialShapes(deps, scope, org), "the credential is not checked against its provider here");
  assertCredentialShape(shapes, provider, credentials);

  const plan = {
    title: `Create provider connection ${name}`,
    changes: [
      `Add a ${provider} credential named ${JSON.stringify(name)} to ${org}.`,
      `Fields: ${Object.keys(credentials).sort().join(", ")}. Values are never printed.`,
      "A new connection is lent to no workspace: assign it with `workspace connections assign`.",
    ],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: connectionsPath(org), body: { name, provider, credentials } });
  report(deps, context, res.raw, `Created provider connection ${name}.`);
}

async function connectionsUpdate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const id = requirePositional(args, "org connections update", "connection id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--name", "--file", "--confirm"] }, "org connections update option");
  const name = takeValue(options, "--name");
  const file = takeValue(options, "--file");
  if (name === undefined && file === undefined) {
    throw new ConfigError("polyant-cli org connections update needs --name <name> or --file <path|-> (or both).");
  }

  const credentials = file === undefined ? undefined : await readCredentials(deps, file);
  const { scope, org } = await readScope(deps, context);

  // Read the collection first: the PATCH body must be checked against the
  // connection's OWN provider, which the caller does not pass and the id does
  // not carry, and a wrong id then fails naming the organisation rather than as
  // a 404 on a uuid.
  const connections = await readIfAllowed(
    deps,
    async () => {
      const listed = await call(deps, scope, { path: connectionsPath(org) });
      return expectArray<ConnectionRow>((listed.body as { connections?: unknown } | null)?.connections, `GET ${connectionsPath(org)}`);
    },
    "the connection and its credential are not checked here",
  );
  const existing = connections?.find((connection) => connection.id === id);
  if (connections !== undefined && existing === undefined) {
    throw new ConfigError(`Organisation ${org} has no provider connection ${JSON.stringify(id)}.`);
  }
  if (existing !== undefined && credentials !== undefined) {
    assertCredentialShape(await credentialShapes(deps, scope, org), existing.provider, credentials);
  }
  const label = existing?.name ?? id;

  const plan = {
    title: `Update provider connection ${label}`,
    changes: [
      ...(name === undefined ? [] : [`Rename it to ${JSON.stringify(name)}.`]),
      ...(credentials === undefined
        ? []
        : [
            `Replace the ${existing?.provider ?? "stored"} credential with fields ${Object.keys(credentials).sort().join(", ")}.`,
            "Every agent using this connection authenticates with the new value from its next turn.",
          ]),
    ],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "PATCH",
    path: connectionsPath(org, id),
    body: { ...(name === undefined ? {} : { name }), ...(credentials === undefined ? {} : { credentials }) },
  });
  report(deps, context, res.raw, `Updated provider connection ${label}.`);
}

async function connectionsDelete(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const id = requirePositional(args, "org connections delete", "connection id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "org connections delete option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Delete provider connection ${id}`,
    changes: [
      `Remove the credential from ${org} and from every workspace it was lent to.`,
      // A role binding's reference to it is a NO ACTION foreign key: the engine
      // answers 409 rather than leave a role bound to nothing.
      "The engine refuses while a role of an agent or of the organisation is bound to it: bind those roles elsewhere first.",
    ],
    destructive: { confirm: id },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: connectionsPath(org, id) });
  report(deps, context, res.raw, `Deleted provider connection ${id}.`);
}

// --- the workspace tier ------------------------------------------------------

/**
 * One row per provider the ORGANISATION holds. A provider it does not hold is
 * absent rather than flagged: since 1.2.0 the engine stops the list at the
 * organisation's tier, so absence is the "cannot be admitted here".
 */
interface WorkspaceProviderRow {
  provider: string;
  admitted: boolean;
}

interface WorkspaceProvidersBody {
  providers?: unknown;
  disabledModels?: { organization?: unknown; workspace?: unknown };
  connections?: unknown;
  managedConnectionsOnly?: unknown;
}

async function workspaceProvidersOf(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  org: string,
  workspace: string,
): Promise<{ body: WorkspaceProvidersBody; raw: string }> {
  const path = workspacePath(org, workspace, "/providers");
  const res = await call(deps, scope, { path });
  return { body: (res.body ?? {}) as WorkspaceProvidersBody, raw: res.raw };
}

async function workspaceProvidersList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const workspace = requirePositional(args, "workspace providers list", "workspace slug");
  assertKnown(args.slice(1), {}, "workspace providers list option");
  const { scope, org } = await readScope(deps, context);
  const { body, raw } = await workspaceProvidersOf(deps, scope, org, workspace);
  if (wantsJson(context)) return writeRawResponse(deps.io, raw);

  writeWorkspaceProviders(deps, body, {
    source: `GET ${workspacePath(org, workspace, "/providers")}`,
    noProviders: `Organisation ${org} is admitted to no providers, so ${workspace} can run none.`,
    noConnections: `Organisation ${org} has no named provider connections.`,
    withAssigned: true,
  });
}

/**
 * The workspace read and the agent's own read share a shape: the agent's is the
 * workspace view narrowed to the connections that workspace was lent.
 */
function writeWorkspaceProviders(
  deps: ServiceDependencies,
  body: WorkspaceProvidersBody,
  wording: { source: string; noProviders: string; noConnections: string; withAssigned: boolean },
): void {
  const providers = expectArray<WorkspaceProviderRow>(body.providers, wording.source);
  const orgDisabled = Array.isArray(body.disabledModels?.organization) ? (body.disabledModels?.organization as string[]) : [];
  const wsDisabled = Array.isArray(body.disabledModels?.workspace) ? (body.disabledModels?.workspace as string[]) : [];
  const connections = Array.isArray(body.connections) ? (body.connections as ConnectionRow[]) : [];

  deps.io.stdout(
    `${renderTable({
      headers: ["PROVIDER", "ADMITTED HERE"],
      rows: providers.map((row) => [text(row.provider), row.admitted ? "yes" : "no"]),
      emptyMessage: wording.noProviders,
    })}\n`,
  );
  writePrettyResource(deps.io, [
    // Two tiers of veto, and they union: a model switched off at either tier is
    // off. Listed separately so the reader knows which one to lift.
    { label: "models off (organisation)", value: orgDisabled.length === 0 ? "(none)" : orgDisabled.join(", ") },
    { label: "models off (workspace)", value: wsDisabled.length === 0 ? "(none)" : wsDisabled.join(", ") },
    { label: "managed connections only", value: body.managedConnectionsOnly === true ? "yes" : "no" },
  ]);
  deps.io.stdout(`\n${connectionTable(connections, wording.noConnections, wording.withAssigned)}\n`);
}

async function agentProviders(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "providers");
  assertKnown(args.slice(1), {}, "agent providers option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/providers");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  writeWorkspaceProviders(deps, (res.body ?? {}) as WorkspaceProvidersBody, {
    source: `GET ${path}`,
    noProviders: `Agent ${slug}'s organisation is admitted to no providers, so the agent can run none.`,
    // Narrowed by the engine to what the workspace was lent, so every row is usable.
    noConnections: `Agent ${slug}'s workspace has been lent no named provider connections.`,
    withAssigned: false,
  });
}


function assertProviderAssignable(providers: readonly WorkspaceProviderRow[], provider: string, org: string): void {
  if (!providers.some((row) => row.provider === provider)) {
    // Admissibility is an intersection, so this row would change nothing.
    throw new ConfigError(
      `Organisation ${org} is not admitted to ${JSON.stringify(provider)}, so a workspace cannot be either. ` +
        `Admitted: ${providers.map((row) => row.provider).join(", ") || "(none)"}. ` +
        "Admitting an organisation to a provider is a platform-admin action, made from the Admin Console.",
    );
  }
}

async function workspaceProviderSet(
  args: string[],
  context: CommandContext | undefined,
  deps: ServiceDependencies,
  admitted: boolean,
): Promise<void> {
  const action = admitted ? "workspace providers admit" : "workspace providers withdraw";
  const workspace = requirePositional(args, action, "workspace slug");
  const provider = requirePositional(args.slice(1), action, "provider name");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, `${action} option`);
  const { scope, org } = await readScope(deps, context);

  const { body } = await workspaceProvidersOf(deps, scope, org, workspace);
  const providers = expectArray<WorkspaceProviderRow>(body.providers, `GET ${workspacePath(org, workspace, "/providers")}`);
  if (admitted) assertProviderAssignable(providers, provider, org);

  const plan = {
    title: `${admitted ? "Admit" : "Withdraw"} ${provider} ${admitted ? "to" : "from"} workspace ${workspace}`,
    changes: admitted
      ? [`Agents in ${workspace} may run ${provider} models the organisation has not switched off.`]
      : [`Agents in ${workspace} stop being able to run ${provider}. One configured for it stops on its next turn.`],
    ...(admitted ? {} : { destructive: { confirm: provider } }),
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PUT", path: workspacePath(org, workspace, "/providers"), body: { provider, admitted } });
  report(deps, context, res.raw, `${admitted ? "Admitted" : "Withdrew"} ${provider} ${admitted ? "to" : "from"} ${workspace}.`);
}

async function workspaceProviderModel(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const workspace = requirePositional(args, "workspace providers model", "workspace slug");
  const provider = requirePositional(args.slice(1), "workspace providers model", "provider name");
  const modelId = requirePositional(args.slice(2), "workspace providers model", "model id");
  const options = args.slice(3);
  assertKnown(options, { value: ["--confirm"], boolean: ["--on", "--off"] }, "workspace providers model option");
  const on = options.includes("--on");
  if (on === options.includes("--off")) throw new ConfigError("polyant-cli workspace providers model needs --on or --off.");

  const { scope, org } = await readScope(deps, context);
  const plan = {
    title: `Switch ${provider}/${modelId} ${on ? "on" : "off"} in workspace ${workspace}`,
    changes: [
      on
        ? `Lift this workspace's veto on ${modelId}. It still needs the organisation's, which is set from the Admin Console.`
        : `Agents in ${workspace} stop being able to select ${modelId}. One already on it stops on its next turn.`,
    ],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "PUT",
    path: workspacePath(org, workspace, "/providers/models"),
    body: { provider, modelId, enabled: on },
  });
  report(deps, context, res.raw, `Switched ${provider}/${modelId} ${on ? "on" : "off"} in ${workspace}.`);
}

async function workspaceConnectionSet(
  args: string[],
  context: CommandContext | undefined,
  deps: ServiceDependencies,
  assigned: boolean,
): Promise<void> {
  const action = assigned ? "workspace connections assign" : "workspace connections revoke";
  const workspace = requirePositional(args, action, "workspace slug");
  const connectionId = requirePositional(args.slice(1), action, "connection id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, `${action} option`);
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `${assigned ? "Lend" : "Withdraw"} connection ${connectionId} ${assigned ? "to" : "from"} workspace ${workspace}`,
    changes: assigned
      ? [`Agents in ${workspace} may bind their roles to this credential by name. They never see its value.`]
      : [`Agents in ${workspace} stop being able to bind it, and a role already bound to it stops at its next use.`],
    ...(assigned ? {} : { destructive: { confirm: connectionId } }),
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "PUT",
    path: workspacePath(org, workspace, "/provider-connections"),
    body: { connectionId, assigned },
  });
  report(deps, context, res.raw, `${assigned ? "Lent" : "Withdrew"} ${connectionId} ${assigned ? "to" : "from"} ${workspace}.`);
}

const TIER_NOTE =
  "Admissibility intersects: the platform admits a provider to the organisation,\nthe organisation admits it to a workspace, and an agent needs both. Models go\nthe other way — they are switched OFF at either tier, and either veto is enough.";

/** The `org providers`, `org connections`, `workspace providers` and `workspace connections` subtrees. */
export const PROVIDER_FAMILY_EXTRAS: Record<string, Record<string, Node>> = {
  org: {
    providers: {
      show: {
        summary: "the providers this organisation may run, and the models it has switched off",
        usage: `Usage: polyant-cli org providers show

Admitting the organisation to a provider is a platform-admin action and is not
on this key's surface: this reports it the way \`org plugins\` reports a grant it
cannot make. What an organisation's own admin decides is per workspace — see
\`workspace providers\`. ${TIER_NOTE}

Engine 1.2.0-ee adds whether the organisation holds the ambient AWS grant
(\`org ambient-aws\`) and the catalogue of providers a connection may be for,
with what each can serve. ${ORG_NOTE}`,
        action: orgProvidersShow,
      },
      "managed-only": {
        summary: "allow agents only the organisation's connections, none of their own",
        usage: `Usage: polyant-cli org providers managed-only --on
       polyant-cli org providers managed-only --off

With it on, a role bound to a connection private to an agent stops rather than
falling back, and no agent may create one — which is the point: a credential
nobody can see is also one nobody can route around. Turn it on after the
connections exist, the workspaces have them, and the agents' roles are bound to
them. ${ORG_NOTE}`,
        action: managedOnly,
        mutates: true,
      },
    },
    connections: {
      list: {
        summary: "list the organisation's named provider credentials",
        usage: `Usage: polyant-cli org connections list

Names, providers and which fields are populated. The engine serves no value, so
neither does this. ${ORG_NOTE}`,
        action: connectionsList,
      },
      create: {
        summary: "create a named provider credential from a file or stdin",
        usage: `Usage: polyant-cli org connections create <name> --provider <name> --file <path|->

The file is a JSON object of credential fields, for example {"api_key": "..."}.
It is read from a file or stdin, never a flag, and never printed. The fields are
checked against the shape the engine reports for that provider first, so a
mistyped field fails naming what the provider takes.

A new connection is lent to no workspace, and nothing uses it until a role is
bound to it (\`agent provider-roles bind\`, \`org provider-roles bind\`). A Bedrock
connection holding a region alone needs the ambient AWS grant. ${ORG_NOTE}`,
        action: connectionsCreate,
        mutates: true,
      },
      update: {
        summary: "rename a connection, or rotate its credential",
        usage: `Usage: polyant-cli org connections update <connectionId> [--name <name>] [--file <path|->]

--file REPLACES the credential; every role bound to the connection authenticates
with the new value from its next use. ${ORG_NOTE}`,
        action: connectionsUpdate,
        mutates: true,
      },
      delete: {
        summary: "delete a named provider credential",
        usage: `Usage: polyant-cli org connections delete <connectionId> --yes --confirm <connectionId>

The engine refuses the delete with a 409 while a role of an agent or of the
organisation is bound to the connection: bind those roles elsewhere first. Create and update need only
org.secret:write; without org.secret:read the CLI skips its own payload checks
and says so. ${ORG_NOTE}`,
        action: connectionsDelete,
        mutates: true,
      },
    },
  },
  workspace: {
    providers: {
      list: {
        summary: "which providers and models one workspace may run",
        usage: `Usage: polyant-cli workspace providers list <workspaceSlug>

Three answers in one read: the providers the organisation holds (one it does
not hold is absent), whether this workspace is admitted to each, and which
models either tier has switched off.
The connections the workspace may use are listed underneath. ${TIER_NOTE}
${ORG_NOTE}`,
        action: workspaceProvidersList,
      },
      admit: {
        summary: "let one workspace run a provider",
        usage: `Usage: polyant-cli workspace providers admit <workspaceSlug> <provider>

Refused locally when the organisation is not admitted to the provider: the row
would change nothing, because admissibility is the intersection of the tiers.
${ORG_NOTE}`,
        action: (args, context, deps) => workspaceProviderSet(args, context, deps, true),
        mutates: true,
      },
      withdraw: {
        summary: "stop one workspace running a provider",
        usage: `Usage: polyant-cli workspace providers withdraw <workspaceSlug> <provider> --yes --confirm <provider>

An agent in that workspace configured for the provider stops on its next turn.
${ORG_NOTE}`,
        action: (args, context, deps) => workspaceProviderSet(args, context, deps, false),
        mutates: true,
      },
      model: {
        summary: "switch one model on or off for a workspace",
        usage: `Usage: polyant-cli workspace providers model <workspaceSlug> <provider> <modelId> --on
       polyant-cli workspace providers model <workspaceSlug> <provider> <modelId> --off

A model is switched OFF, never on: everything the catalogue offers under an
admitted provider is available until someone vetoes it, so a catalogue refresh
reaches the tenant. --on lifts THIS workspace's veto and nothing else — the
organisation's is set from the Admin Console. ${ORG_NOTE}`,
        action: workspaceProviderModel,
        mutates: true,
      },
    },
    connections: {
      assign: {
        summary: "lend a named credential to one workspace",
        usage: `Usage: polyant-cli workspace connections assign <workspaceSlug> <connectionId>

Whoever builds an agent in that workspace can then bind its roles to the
credential by name, and never sees its value. ${ORG_NOTE}`,
        action: (args, context, deps) => workspaceConnectionSet(args, context, deps, true),
        mutates: true,
      },
      revoke: {
        summary: "stop one workspace using a named credential",
        usage: `Usage: polyant-cli workspace connections revoke <workspaceSlug> <connectionId> --yes --confirm <connectionId>

A role bound to it there stops at its next use rather than falling back.
${ORG_NOTE}`,
        action: (args, context, deps) => workspaceConnectionSet(args, context, deps, false),
        mutates: true,
      },
    },
  },
};

/** `agent providers`: one leaf on the agent tree, kept beside the tiers it reads. */
export const agentProvidersLeaf: Node = {
  summary: "the providers, models and named connections this agent may be pointed at",
  usage: `Usage: polyant-cli agent providers <slug>

The workspace's view, read with agent:read alone: which providers the agent's
workspace is admitted to, which models either tier has switched off, and the
named connections lent to the workspace — the values \`agent update --provider\`
and \`--model\` can take without being refused. Names and providers only, never
a credential. Which connection each of the agent's roles is bound to, and the
ones private to the agent, are in \`agent provider-roles show\`. ${TIER_NOTE}`,
  action: agentProviders,
};
