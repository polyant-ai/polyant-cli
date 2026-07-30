// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type {
  MembersResponse,
  OrganizationsResponse,
  RolePermissionsResponse,
  RolesResponse,
  WorkspacesResponse,
} from "../api/types.js";
import type { Command, CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { confirmMutation, type MutationPlan } from "../runtime/confirm.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { call, expectArray, processServiceDependencies, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { ResolvedScope } from "../runtime/scope.js";

/**
 * Administration is organisation-scoped, not workspace-scoped: the organisation
 * is a path segment, so it must be known before a path is assembled. A management
 * key belongs to exactly one organisation and `/api/service-context` reports it,
 * so `--org` is a way to be explicit rather than a thing to look up.
 */
async function orgFor(deps: ServiceDependencies, scope: ResolvedScope, context: CommandContext | undefined): Promise<string> {
  const explicit = context?.global.org ?? scope.org;
  if (explicit !== undefined && explicit.trim().length > 0) return explicit;

  const res = await call(deps, scope, { path: "/api/service-context" });
  const slug = (res.body as { organization?: { slug?: unknown } } | null)?.organization?.slug;
  if (typeof slug !== "string" || slug.length === 0) {
    throw new ConfigError(
      "Cannot resolve an organisation: pass --org <slug>, or select a context. " +
        "GET /api/service-context reported none for this key.",
    );
  }
  return slug;
}

function orgPath(org: string, rest = ""): string {
  return `/api/organizations/${encodeURIComponent(org)}${rest}`;
}

function planScope(scope: ResolvedScope, org: string): MutationPlan["scope"] {
  return { target: scope.target.name, prod: scope.target.prod, org };
}

async function preflight(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  org: string,
  context: CommandContext | undefined,
  args: readonly string[],
  plan: Omit<MutationPlan, "scope">,
): Promise<boolean> {
  const confirm = takeValue(args, "--confirm");
  const decision = await confirmMutation(
    { ...plan, scope: planScope(scope, org) },
    {
      yes: context?.global.yes ?? false,
      dryRun: context?.global.dryRun ?? false,
      ...(confirm === undefined ? {} : { confirm }),
    },
    deps.io,
  );
  return decision.shouldWrite;
}

/** Reads need only a target: the organisation comes from the key itself. */
async function readScope(deps: ServiceDependencies, context: CommandContext | undefined) {
  const scope = await scopeFor(deps, context, "read");
  return { scope, org: await orgFor(deps, scope, context) };
}

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

async function orgRename(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--name", "--confirm"] }, "org rename option");
  const name = takeValue(args, "--name");
  if (name === undefined) throw new ConfigError("polyant-cli org rename needs --name <name>.");
  const { scope, org } = await readScope(deps, context);

  if (!(await preflight(deps, scope, org, context, args, { title: `Rename organisation ${org}`, changes: [`Set name to ${JSON.stringify(name)}.`] }))) return;

  const res = await call(deps, scope, { method: "PATCH", path: orgPath(org), body: { name } });
  report(deps, context, res.raw, `Renamed organisation ${org}.`);
}

function report(deps: ServiceDependencies, context: CommandContext | undefined, raw: string, message: string): void {
  if (wantsJson(context)) return writeRawResponse(deps.io, raw);
  deps.io.stdout(`${message}\n`);
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

function requireSlug(args: readonly string[], action: string, what = "slug"): string {
  const value = args[0];
  if (value === undefined || value.startsWith("--")) throw new ConfigError(`polyant-cli ${action} needs a ${what}.`);
  return value;
}

async function workspaceCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "workspace create");
  const options = args.slice(1);
  assertKnown(options, { value: ["--name", "--confirm"] }, "workspace create option");
  const name = takeValue(options, "--name") ?? slug;
  const { scope, org } = await readScope(deps, context);

  const plan = { title: `Create workspace ${slug}`, changes: [`Add workspace ${slug} named ${JSON.stringify(name)} to ${org}.`] };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: orgPath(org, "/workspaces"), body: { slug, name } });
  report(deps, context, res.raw, `Created workspace ${slug}.`);
}

async function workspaceUpdate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "workspace update");
  const options = args.slice(1);
  assertKnown(options, { value: ["--name", "--confirm"] }, "workspace update option");
  const name = takeValue(options, "--name");
  if (name === undefined) throw new ConfigError("polyant-cli workspace update needs --name <name>.");
  const { scope, org } = await readScope(deps, context);

  if (!(await preflight(deps, scope, org, context, options, { title: `Update workspace ${slug}`, changes: [`Set name to ${JSON.stringify(name)}.`] }))) return;

  // The path segment takes a slug: the engine keeps workspace ids off the wire.
  const res = await call(deps, scope, { method: "PATCH", path: orgPath(org, `/workspaces/${encodeURIComponent(slug)}`), body: { name } });
  report(deps, context, res.raw, `Updated workspace ${slug}.`);
}

async function workspaceDelete(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "workspace delete");
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

  const res = await call(deps, scope, { method: "DELETE", path: orgPath(org, `/workspaces/${encodeURIComponent(slug)}`) });
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
  const who = requireSlug(args, "member show", "user id or email");
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
  const userId = requireSlug(args, "member remove", "user id");
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
  const key = requireSlug(args, "role show", "role key");
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
  const key = requireSlug(args, "role create", "role key");
  const options = args.slice(1);
  assertKnown(options, { value: ["--name", "--permissions", "--confirm"] }, "role create option");
  const permissions = permissionList(options, "--permissions");
  if (permissions.length === 0) throw new ConfigError("polyant-cli role create needs --permissions <key,key>.");
  const name = takeValue(options, "--name") ?? key;
  const { scope, org } = await readScope(deps, context);

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
  const key = requireSlug(args, "role delete", "role id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "role delete option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Delete role ${key}`,
    changes: [`Delete custom role ${key} from ${org}.`, "Members holding it lose the permissions it granted."],
    destructive: { confirm: key },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: orgPath(org, `/roles/${encodeURIComponent(key)}`) });
  report(deps, context, res.raw, `Deleted role ${key}.`);
}

// --- command tree ----------------------------------------------------------

type Action = (args: string[], context: CommandContext | undefined, deps: ServiceDependencies) => Promise<void>;

interface Leaf {
  readonly summary: string;
  readonly usage: string;
  readonly action: Action;
  readonly mutates?: boolean;
}

const ORG_NOTE = "The organisation comes from the key when --org is absent.";

const FAMILIES: Record<string, Record<string, Leaf>> = {
  org: {
    list: {
      summary: "show the organisation this key belongs to",
      usage: `Usage: polyant-cli org list\n\nA management key is scoped to one organisation, and the engine serves no\nper-organisation detail route, so this listing is the detail.`,
      action: orgList,
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
      usage: `Usage: polyant-cli workspace update <slug> --name <name>\n\n${ORG_NOTE}`,
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
      usage: `Usage: polyant-cli role create <key> --permissions <key,key> [--name <name>]\n\nEvery permission is checked against the engine's grantable set first, so a typo\nfails naming the offending key. ${ORG_NOTE}`,
      action: roleCreate,
      mutates: true,
    },
    delete: {
      summary: "delete a custom role",
      usage: `Usage: polyant-cli role delete <roleId> --yes --confirm <roleId>\n\n${ORG_NOTE}`,
      action: roleDelete,
      mutates: true,
    },
  },
};

function toCommand(leaf: Leaf, deps: ServiceDependencies): Command {
  return {
    summary: leaf.summary,
    usage: leaf.usage,
    ...(leaf.mutates === true ? { supportsDryRun: true } : {}),
    run: (args, context) => leaf.action(args, context, deps),
  };
}

const FAMILY_SUMMARY: Record<string, string> = {
  org: "inspect and rename the organisation",
  workspace: "manage the organisation's workspaces",
  member: "inspect the organisation's members",
  role: "manage the organisation's custom roles",
};

export function createAdminCommands(overrides: Partial<ServiceDependencies> = {}): Record<string, Command> {
  const deps = { ...processServiceDependencies, ...overrides };
  const families: Record<string, Command> = {};
  for (const [name, actions] of Object.entries(FAMILIES)) {
    const children: Record<string, Command> = {};
    for (const [action, leaf] of Object.entries(actions)) children[action] = toCommand(leaf, deps);
    families[name] = {
      summary: FAMILY_SUMMARY[name],
      usage: `Usage: polyant-cli ${name} <action> [options]`,
      children,
    };
  }
  return families;
}

export const adminCommands = createAdminCommands();
