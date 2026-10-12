// SPDX-License-Identifier: Apache-2.0
import type {
  MembersResponse,
  AgentSummary,
  ListAgentsResponse,
  OrganizationTask,
  OrganizationsResponse,
  RolePermissionsResponse,
  RoleSummary,
  RolesResponse,
  WorkspacesResponse,
  ScheduledTask,
  ScheduledTasksResponse,
} from "../api/types.js";
import type { Command, CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { ORG_NOTE, orgPath, preflight, readScope, report, requirePositional, roleIdFor, workspaceIdFor } from "../runtime/org.js";
import { call, expectArray, processServiceDependencies, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import { buildNode, type Node } from "../runtime/tree.js";
import type { ResolvedScope } from "../runtime/scope.js";
import { orgAuditFamily } from "./audit.js";
import { governanceFamily } from "./governance.js";
import { memberInvitationsFamily } from "./invitations.js";
import { KNOWLEDGE_FAMILY_EXTRAS } from "./knowledge-library.js";
import { ORG_FAMILY_EXTRAS, apiKeyFamily } from "./org-ops.js";
import { PROVIDER_FAMILY_EXTRAS } from "./providers.js";
import { PROVIDER_ROLE_FAMILY_EXTRAS } from "./provider-roles.js";
import { skillFamily } from "./skills.js";
import { credentialKind, refusePersonalToken } from "../runtime/credential.js";

// --- organisations ---------------------------------------------------------

async function orgList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "org list option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: "/api/organizations" });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  // A management key is org-scoped, so this is its own organisation and nothing
  // else. There is no per-organisation detail route, so this list is the detail.
  const organizations = expectArray<OrganizationsResponse["organizations"][number]>(
    (res.body as Partial<OrganizationsResponse> | null)?.organizations,
    "GET /api/organizations",
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["SLUG", "NAME", "ID", "DEFAULT"],
      rows: organizations.map((org) => [org.slug, text(org.name), text(org.id), org.isDefault === true ? "yes" : "no"]),
      emptyMessage: "This key can see no organisation.",
    })}\n`,
  );
}

async function orgCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requirePositional(args, "org create");
  const options = args.slice(1);
  assertKnown(options, { value: ["--name", "--confirm"] }, "org create option");
  const name = takeValue(options, "--name");
  if (name === undefined) throw new ConfigError("polyant-cli org create needs --name <name>.");
  const scope = await scopeFor(deps, context, "target");
  if (!(await preflight(deps, scope, slug, context, options, {
    title: `Create organisation ${slug}`,
    changes: [
      `Create organisation ${slug} named ${JSON.stringify(name)}.`,
      "Create its default workspace as general.",
    ],
  }))) return;
  const res = await call(deps, scope, {
    method: "POST",
    path: "/api/organizations",
    body: { slug, name },
  });
  report(deps, context, res.raw, `Created organisation ${slug} with default workspace general.`);
}

const TASK_PAGE_SIZE = 500;

async function organizationTasks(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  workspaces: Array<{ slug: string }>,
): Promise<OrganizationTask[]> {
  const rows: OrganizationTask[] = [];
  for (const workspace of workspaces) {
    const workspaceScope = { ...scope, workspace: workspace.slug };
    const agentsRes = await call(deps, workspaceScope, { path: "/api/instances" });
    const agents = expectArray<AgentSummary>(
      (agentsRes.body as Partial<ListAgentsResponse> | null)?.instances,
      "GET /api/instances",
    );
    for (const agent of agents) {
      for (let offset = 0; ; offset += TASK_PAGE_SIZE) {
        const tasksRes = await call(deps, workspaceScope, {
          path: `/api/instances/${encodeURIComponent(agent.slug)}/scheduled-tasks`,
          query: { limit: String(TASK_PAGE_SIZE), offset: String(offset) },
        });
        const tasks = expectArray<ScheduledTask>(
          (tasksRes.body as Partial<ScheduledTasksResponse> | null)?.tasks,
          "GET scheduled tasks",
        );
        rows.push(...tasks.map((task) => ({
          ...task,
          workspace: workspace.slug,
          agent: agent.slug,
        })));
        if (tasks.length < TASK_PAGE_SIZE) break;
      }
    }
  }
  return rows;
}

async function orgTasksList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "org tasks list option");
  const scope = await scopeFor(deps, context, "target");
  const contextRes = await call(deps, scope, { path: "/api/service-context" });
  const serviceContext = contextRes.body as {
    organization?: { slug?: unknown };
    workspaces?: unknown;
  } | null;
  const org = serviceContext?.organization?.slug;
  if (typeof org !== "string" || org.length === 0) {
    throw new ConfigError("GET /api/service-context did not identify this key's organisation.");
  }
  const requestedOrg = context?.global.org ?? scope.org;
  if (requestedOrg !== undefined && requestedOrg !== org) {
    throw new ConfigError(`This key belongs to organisation ${JSON.stringify(org)}, not ${JSON.stringify(requestedOrg)}.`);
  }
  const workspaces = expectArray<{ slug: string }>(
    serviceContext?.workspaces,
    "GET /api/service-context",
  );
  const rows = await organizationTasks(deps, scope, workspaces);
  if (wantsJson(context)) return writeRawResponse(deps.io, JSON.stringify(rows));
  deps.io.stdout(
    `${renderTable({
      headers: ["WORKSPACE", "AGENT", "ID", "NAME", "SCHEDULE", "ENABLED", "NEXT RUN"],
      rows: rows.map((task) => [
        task.workspace,
        task.agent,
        text(task.id),
        text(task.name),
        text(task.scheduleHuman),
        task.enabled ? "yes" : "no",
        text(task.nextRunAt),
      ]),
      emptyMessage: `Organisation ${org} has no scheduled tasks.`,
    })}\n`,
  );
}

async function orgRename(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--name", "--confirm"] }, "org rename option");
  const name = takeValue(args, "--name");
  if (name === undefined) throw new ConfigError("polyant-cli org rename needs --name <name>.");
  const { scope, org } = await readScope(deps, context);

  if (!(await preflight(deps, scope, org, context, args, { title: `Rename organisation ${org}`, changes: [`Set name to ${JSON.stringify(name)}.`] }))) return;

  const res = await call(deps, scope, { method: "PATCH", path: orgPath(org), body: { name } });
  report(deps, context, res.raw, `Renamed organisation ${org}.`);
}

// --- workspaces ------------------------------------------------------------

async function workspaceList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "workspace list option");
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: orgPath(org, "/workspaces") });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const workspaces = expectArray<WorkspacesResponse["workspaces"][number]>(
    (res.body as Partial<WorkspacesResponse> | null)?.workspaces,
    `GET ${orgPath(org, "/workspaces")}`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["SLUG", "NAME", "DEFAULT", "UPDATED"],
      rows: workspaces.map((ws) => [ws.slug, text(ws.name), ws.isDefault ? "yes" : "no", text(ws.updatedAt)]),
      emptyMessage: `Organisation ${org} has no workspaces.`,
    })}\n`,
  );
}

async function workspaceCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requirePositional(args, "workspace create");
  const options = args.slice(1);
  assertKnown(options, { value: ["--name", "--confirm"] }, "workspace create option");
  const name = takeValue(options, "--name") ?? slug;
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Create workspace ${slug}`,
    changes: [
      `Add workspace ${slug} named ${JSON.stringify(name)} to ${org}.`,
      // A person creating a workspace is bound as its owner (engine 1.2.0); a
      // management key is no person, so nobody is.
      ...(credentialKind(scope.target.key) === "personal-token"
        ? ["You become the workspace's owner: the engine binds the person who creates it."]
        : []),
    ],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: orgPath(org, "/workspaces"), body: { slug, name } });
  report(deps, context, res.raw, `Created workspace ${slug}.`);
}

async function workspaceUpdate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requirePositional(args, "workspace update");
  const options = args.slice(1);
  assertKnown(options, { value: ["--name", "--confirm"] }, "workspace update option");
  const name = takeValue(options, "--name");
  if (name === undefined) throw new ConfigError("polyant-cli workspace update needs --name <name>.");
  const { scope, org } = await readScope(deps, context);

  if (!(await preflight(deps, scope, org, context, options, { title: `Update workspace ${slug}`, changes: [`Set name to ${JSON.stringify(name)}.`] }))) return;

  const workspaceId = await workspaceIdFor(deps, scope, org, slug);
  const res = await call(deps, scope, { method: "PATCH", path: orgPath(org, `/workspaces/${workspaceId}`), body: { name } });
  report(deps, context, res.raw, `Updated workspace ${slug}.`);
}

async function workspaceDelete(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requirePositional(args, "workspace delete");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "workspace delete option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Delete workspace ${slug}`,
    changes: [
      `Delete workspace ${slug} from ${org}.`,
      "The engine exposes deletion only — there is no archive, so this is not reversible.",
    ],
    destructive: { confirm: slug },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const workspaceId = await workspaceIdFor(deps, scope, org, slug);
  const res = await call(deps, scope, { method: "DELETE", path: orgPath(org, `/workspaces/${workspaceId}`) });
  report(deps, context, res.raw, `Deleted workspace ${slug}.`);
}

// --- members ---------------------------------------------------------------

async function memberList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "member list option");
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: orgPath(org, "/members") });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const members = expectArray<MembersResponse["members"][number]>(
    (res.body as Partial<MembersResponse> | null)?.members,
    `GET ${orgPath(org, "/members")}`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["EMAIL", "NAME", "ROLE", "USER ID"],
      rows: members.map((m) => [text(m.email), text(m.name), text(m.roleKey), text(m.userId)]),
      emptyMessage: `Organisation ${org} has no members.`,
    })}\n`,
  );
}

async function memberShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const who = requirePositional(args, "member show", "user id or email");
  assertKnown(args.slice(1), {}, "member show option");
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: orgPath(org, "/members") });

  // There is no per-member route: the list is the only source, so the selection
  // happens here rather than being faked as a remote lookup.
  const members = expectArray<MembersResponse["members"][number]>(
    (res.body as Partial<MembersResponse> | null)?.members,
    `GET ${orgPath(org, "/members")}`,
  );
  const found = members.find((m) => m.userId === who || m.email === who);
  if (found === undefined) throw new ConfigError(`Organisation ${org} has no member ${JSON.stringify(who)}.`);
  if (wantsJson(context)) return writeRawResponse(deps.io, `${JSON.stringify({ member: found })}\n`);

  writePrettyResource(deps.io, [
    { label: "email", value: text(found.email) },
    { label: "name", value: text(found.name) },
    { label: "role", value: text(found.roleKey) },
    { label: "userId", value: text(found.userId) },
  ]);
}

async function memberRemove(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const userId = requirePositional(args, "member remove", "user id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "member remove option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Remove member ${userId}`,
    changes: [
      `Remove ${userId} from organisation ${org}.`,
      "Requires a user principal: the engine grants a management key no rank in the role hierarchy.",
    ],
    destructive: { confirm: userId },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: orgPath(org, `/members/${encodeURIComponent(userId)}`) });
  report(deps, context, res.raw, `Removed member ${userId}.`);
}

// --- roles -----------------------------------------------------------------

async function roleList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "role list option");
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: orgPath(org, "/roles") });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const roles = expectArray<RolesResponse["roles"][number]>(
    (res.body as Partial<RolesResponse> | null)?.roles,
    `GET ${orgPath(org, "/roles")}`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["KEY", "NAME", "PERMISSIONS"],
      rows: roles.map((role) => [text(role.key), text(role.name), String((role.permissions ?? []).length)]),
      emptyMessage: `Organisation ${org} has no custom roles. The system roles are built in.`,
    })}\n`,
  );
}

async function roleShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const key = requirePositional(args, "role show", "role key");
  assertKnown(args.slice(1), {}, "role show option");
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: orgPath(org, "/roles") });

  const roles = expectArray<RolesResponse["roles"][number]>(
    (res.body as Partial<RolesResponse> | null)?.roles,
    `GET ${orgPath(org, "/roles")}`,
  );
  const found = roles.find((role) => role.key === key || role.id === key);
  if (found === undefined) throw new ConfigError(`Organisation ${org} has no custom role ${JSON.stringify(key)}.`);
  if (wantsJson(context)) return writeRawResponse(deps.io, `${JSON.stringify({ role: found })}\n`);

  writePrettyResource(deps.io, [
    { label: "key", value: text(found.key) },
    { label: "name", value: text(found.name) },
    { label: "description", value: text(found.description) },
    { label: "permissions", value: (found.permissions ?? []).join(", ") || "(none)" },
  ]);
}

async function rolePermissions(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "role permissions option");
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: orgPath(org, "/roles/permissions") });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const permissions = expectArray<string>(
    (res.body as Partial<RolePermissionsResponse> | null)?.permissions,
    `GET ${orgPath(org, "/roles/permissions")}`,
  );
  deps.io.stdout(`${[...permissions].sort().join("\n")}\n`);
}

function permissionList(options: readonly string[], flag: string): string[] {
  const value = takeValue(options, flag);
  if (value === undefined) return [];
  const keys = value.split(",").map((key) => key.trim()).filter((key) => key.length > 0);
  if (keys.length === 0) throw new ConfigError(`${flag} needs at least one permission key.`);
  return keys;
}

async function roleCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const key = requirePositional(args, "role create", "role key");
  const options = args.slice(1);
  assertKnown(options, { value: ["--name", "--permissions", "--confirm"] }, "role create option");
  const permissions = permissionList(options, "--permissions");
  if (permissions.length === 0) throw new ConfigError("polyant-cli role create needs --permissions <key,key>.");
  const name = takeValue(options, "--name") ?? key;
  const { scope, org } = await readScope(deps, context);
  refusePersonalToken(scope, "role create");

  // Validate against what the engine says is grantable, so a typo fails naming
  // the offending key rather than as an opaque 400.
  const catalogue = await call(deps, scope, { path: orgPath(org, "/roles/permissions") });
  const known = new Set(
    expectArray<string>((catalogue.body as Partial<RolePermissionsResponse> | null)?.permissions, `GET ${orgPath(org, "/roles/permissions")}`),
  );
  const unknown = permissions.filter((permission) => !known.has(permission));
  if (unknown.length > 0) {
    throw new ConfigError(`Not grantable in ${org}: ${unknown.join(", ")}. Run "polyant-cli role permissions" for the full set.`);
  }

  const plan = {
    title: `Create role ${key}`,
    changes: [`Add role ${key} named ${JSON.stringify(name)}.`, `Grant: ${permissions.join(", ")}.`],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: orgPath(org, "/roles"), body: { key, name, permissions } });
  report(deps, context, res.raw, `Created role ${key}.`);
}

async function roleDelete(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const key = requirePositional(args, "role delete", "role key");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "role delete option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Delete role ${key}`,
    changes: [`Delete custom role ${key} from ${org}.`, "Members holding it lose the permissions it granted."],
    destructive: { confirm: key },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const roleId = await roleIdFor(deps, scope, org, key);
  const res = await call(deps, scope, { method: "DELETE", path: orgPath(org, `/roles/${roleId}`) });
  report(deps, context, res.raw, `Deleted role ${key}.`);
}

// --- command tree ----------------------------------------------------------

const FAMILIES: Record<string, Record<string, Node>> = {
  org: {
    create: {
      summary: "create an organisation with its default workspace",
      usage: "Usage: polyant-cli org create <slug> --name <name>\n\nCreates the default workspace as general. Requires a current platform-administrator personal token.",
      action: orgCreate,
      mutates: true,
    },
    list: {
      summary: "show the organisation this key belongs to",
      usage: `Usage: polyant-cli org list\n\nA management key is scoped to one organisation, and the engine serves no\nper-organisation detail route, so this listing is the detail.`,
      action: orgList,
    },
    tasks: {
      list: {
        summary: "list scheduled tasks across the organisation",
        usage: `Usage: polyant-cli org tasks list\n\nCollects every workspace and agent before printing, so failures never produce a partial table. ${ORG_NOTE}`,
        action: orgTasksList,
      },
    },
    rename: {
      summary: "rename the organisation",
      usage: `Usage: polyant-cli org rename --name <name>\n\n${ORG_NOTE}`,
      action: orgRename,
      mutates: true,
    },
  },
  workspace: {
    list: { summary: "list the organisation's workspaces", usage: `Usage: polyant-cli workspace list\n\n${ORG_NOTE}`, action: workspaceList },
    create: {
      summary: "create a workspace",
      usage: `Usage: polyant-cli workspace create <slug> [--name <name>]\n\n${ORG_NOTE}`,
      action: workspaceCreate,
      mutates: true,
    },
    update: {
      summary: "rename a workspace",
      usage: `Usage: polyant-cli workspace update <slug> --name <name>\n\nThe slug is resolved to the workspace's id, which is what the engine's path\ntakes. ${ORG_NOTE}`,
      action: workspaceUpdate,
      mutates: true,
    },
    delete: {
      summary: "delete a workspace",
      usage: `Usage: polyant-cli workspace delete <slug> --yes --confirm <slug>\n\nThe engine exposes deletion only: there is no archive, so this is not\nreversible. ${ORG_NOTE}`,
      action: workspaceDelete,
      mutates: true,
    },
  },
  member: {
    list: { summary: "list the organisation's members", usage: `Usage: polyant-cli member list\n\n${ORG_NOTE}`, action: memberList },
    show: {
      summary: "show one member by user id or email",
      usage: `Usage: polyant-cli member show <userId|email>\n\nThe engine serves no per-member route, so the selection happens locally over\nthe member list. ${ORG_NOTE}`,
      action: memberShow,
    },
    remove: {
      summary: "remove a member from the organisation",
      usage: `Usage: polyant-cli member remove <userId> --yes --confirm <userId>\n\nRequires a user principal: the engine grants a management key no rank in the\nrole hierarchy, so with a management key this answers 403. ${ORG_NOTE}`,
      action: memberRemove,
      mutates: true,
    },
  },
  role: {
    list: { summary: "list the organisation's custom roles", usage: `Usage: polyant-cli role list\n\n${ORG_NOTE}`, action: roleList },
    show: {
      summary: "show one custom role and its permissions",
      usage: `Usage: polyant-cli role show <key>\n\n${ORG_NOTE}`,
      action: roleShow,
    },
    permissions: {
      summary: "list the permission keys a role may grant",
      usage: `Usage: polyant-cli role permissions\n\nOne key per line, sorted, so it pipes into grep. ${ORG_NOTE}`,
      action: rolePermissions,
    },
    create: {
      summary: "create a custom role",
      usage: `Usage: polyant-cli role create <key> --permissions <key,key> [--name <name>]\n\nEvery permission is checked against the engine's grantable set first, so a typo\nfails naming the offending key. A personal token is refused (engine 1.2.0): it\nis reserved for an interactive session or a management key. ${ORG_NOTE}`,
      action: roleCreate,
      mutates: true,
    },
    delete: {
      summary: "delete a custom role",
      usage: `Usage: polyant-cli role delete <key> --yes --confirm <key>\n\nThe key is resolved to the role's id, which is what the engine's path takes.\n${ORG_NOTE}`,
      action: roleDelete,
      mutates: true,
    },
  },
  apikey: apiKeyFamily,
  skill: skillFamily,
  governance: governanceFamily,
};

const FAMILY_SUMMARIES: Record<string, string> = {
  org: "inspect the organisation, rename it, and share its credentials",
  "org secrets": "the credentials every agent in the organisation falls back to",
  "org audit": "who changed what, and who was refused",
  "org providers": "which providers and models this organisation may run",
  "org connections": "the organisation's named provider credentials",
  "org provider-roles": "which connection each of the organisation's credential roles runs on (Enterprise)",
  "org ambient-aws": "whether an organisation may use the deployment's AWS identity (Platform Admin)",
  "org knowledge": "the organisation's shared knowledge library",
  "org tasks": "scheduled tasks across every workspace and agent",
  workspace: "manage the organisation's workspaces and who is bound to them",
  "workspace member": "bind a member to one workspace",
  "workspace skills": "which of the organisation's skills one workspace may use",
  "workspace plugins": "which of the organisation's plugins one workspace may use",
  "workspace providers": "which providers and models one workspace may run",
  "workspace connections": "which named credentials one workspace may use",
  "workspace knowledge": "one workspace's own knowledge library",
  member: "inspect the organisation's members and set their roles",
  "member invitations": "how somebody gets into the organisation",
  role: "manage the organisation's custom roles",
  apikey: "issue and revoke the management API keys the CLI authenticates with",
  skill: "manage the organisation's skill catalog",
  governance: "policies, gates and the governance posture",
  "governance policy": "the organisation's governance policy catalog",
};

/** Subtrees that are one node each, and would not earn a module-wide map. */
const EXTRA_SUBTREES: Record<string, Record<string, Node>> = {
  org: { audit: orgAuditFamily },
  member: { invitations: memberInvitationsFamily },
};

/**
 * The administration families. `org`, `workspace` and `member` each gain
 * subtrees from `org-ops.ts`, `providers.ts`, `knowledge-library.ts`,
 * `audit.ts` and `invitations.ts`; merging them here keeps one `org` command
 * rather than splitting the same noun across five places in the help.
 */
export function createAdminCommands(overrides: Partial<ServiceDependencies> = {}): Record<string, Command> {
  const deps = { ...processServiceDependencies, ...overrides };
  const families: Record<string, Command> = {};
  for (const [name, actions] of Object.entries(FAMILIES)) {
    families[name] = buildNode(
      {
        ...actions,
        ...(ORG_FAMILY_EXTRAS[name] ?? {}),
        ...(PROVIDER_FAMILY_EXTRAS[name] ?? {}),
        ...(PROVIDER_ROLE_FAMILY_EXTRAS[name] ?? {}),
        ...(KNOWLEDGE_FAMILY_EXTRAS[name] ?? {}),
        ...(EXTRA_SUBTREES[name] ?? {}),
      },
      deps,
      [name],
      FAMILY_SUMMARIES,
    );
  }
  return families;
}

export const adminCommands = createAdminCommands();
