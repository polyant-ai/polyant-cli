// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import {
  ORG_NOTE,
  orgPath,
  preflight,
  readScope,
  report,
  requirePositional,
  workspaceIdFor,
} from "../runtime/org.js";
import { call, expectArray, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";
import type { ResolvedScope } from "../runtime/scope.js";

// --- organisation-level provider credentials --------------------------------

/**
 * The organisation's provider credentials. Same wire shape as an agent's
 * (`PutSecretsSchema` is shared by both routes in the engine), and the same
 * value-never-printed rule — but a different resolution order: an agent's own
 * secret wins, this one is the fallback, so ten agents on one OpenAI account
 * share one key instead of ten.
 */
function orgSecretsPath(org: string, key?: string): string {
  return orgPath(org, key === undefined ? "/secrets" : `/secrets/${encodeURIComponent(key)}`);
}

interface SecretRow {
  key: string;
  configured: boolean;
}

async function orgSecretsOf(deps: ServiceDependencies, scope: ResolvedScope, org: string): Promise<SecretRow[]> {
  const path = orgSecretsPath(org);
  const res = await call(deps, scope, { path });
  return expectArray<SecretRow>((res.body as { secrets?: unknown } | null)?.secrets, `GET ${path}`);
}

async function orgSecretsShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { boolean: ["--configured-only"] }, "org secrets show option");
  const { scope, org } = await readScope(deps, context);
  const path = orgSecretsPath(org);
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const all = expectArray<SecretRow>((res.body as { secrets?: unknown } | null)?.secrets, `GET ${path}`);
  const secrets = args.includes("--configured-only") ? all.filter((secret) => secret.configured) : all;
  deps.io.stdout(
    `${renderTable({
      headers: ["KEY", "CONFIGURED"],
      rows: secrets.map((secret) => [secret.key, secret.configured ? "yes" : "no"]),
      emptyMessage: `Organisation ${org} shares no provider credentials.`,
    })}\n`,
  );
}

function requireKeyFlag(options: readonly string[], action: string): string {
  const key = takeValue(options, "--key");
  if (key === undefined) throw new ConfigError(`polyant-cli ${action} needs --key <name>.`);
  return key;
}

/**
 * The engine refuses a key that can never apply at the organisation level — an
 * inbound credential like `auth_api_key` authenticates a caller to one agent, so
 * shared it would be a silent no-op. It only serves shareable keys here, so the
 * declared set is the check.
 */
function assertShareable(secrets: readonly SecretRow[], key: string, org: string): SecretRow {
  const found = secrets.find((secret) => secret.key === key);
  if (found !== undefined) return found;
  throw new ConfigError(
    `Organisation ${org} cannot share a credential named ${JSON.stringify(key)}. ` +
      `Shareable: ${secrets.map((secret) => secret.key).join(", ")}.`,
  );
}

async function orgSecretsSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--key", "--file", "--confirm"] }, "org secrets set option");
  const key = requireKeyFlag(args, "org secrets set");
  const file = takeValue(args, "--file");
  if (file === undefined) throw new ConfigError('polyant-cli org secrets set needs --file <path> (or --file - for stdin).');

  // Read before the recap, never into one: an inline secret lands in shell
  // history and in `ps`, and a printed one lands wherever the terminal is captured.
  const value = (await deps.readPayload(file)).trim();
  if (value.length === 0) throw new ConfigError(`${file === "-" ? "stdin" : file} contained no value.`);

  const { scope, org } = await readScope(deps, context);
  const existing = assertShareable(await orgSecretsOf(deps, scope, org), key, org);

  const changes = [
    existing.configured ? `Replace the stored ${key}.` : `Set ${key}, which is not configured yet.`,
    `Every agent in ${org} without its own ${key} starts using this one.`,
    `Value: ${value.length} characters from ${file === "-" ? "stdin" : file}, never shown.`,
  ];
  if (!(await preflight(deps, scope, org, context, args, { title: `Set organisation credential ${key}`, changes }))) return;

  const res = await call(deps, scope, { method: "PUT", path: orgSecretsPath(org), body: { secrets: [{ key, value }] } });
  report(deps, context, res.raw, `Set organisation credential ${key}.`);
}

async function orgSecretsUnset(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--key", "--confirm"] }, "org secrets unset option");
  const key = requireKeyFlag(args, "org secrets unset");
  const { scope, org } = await readScope(deps, context);
  const existing = assertShareable(await orgSecretsOf(deps, scope, org), key, org);
  if (!existing.configured) {
    // The engine answers 200 for a key it never held, so without this a typo
    // would report success while the real credential stayed in place.
    throw new ConfigError(`Organisation ${org} has no stored ${key}; there is nothing to remove.`);
  }

  const plan = {
    title: `Remove organisation credential ${key}`,
    changes: [`Delete the shared ${key}. Every agent falling back to it loses the credential.`],
    destructive: { confirm: key },
  };
  if (!(await preflight(deps, scope, org, context, args, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: orgSecretsPath(org, key) });
  report(deps, context, res.raw, `Removed organisation credential ${key}.`);
}

// --- plugin grants ----------------------------------------------------------

interface PluginRow {
  name: string;
  version: string;
  compatible: boolean;
  enabled: boolean;
}

async function orgPlugins(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "org plugins option");
  const { scope, org } = await readScope(deps, context);
  const path = orgPath(org, "/plugins");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const plugins = expectArray<PluginRow>((res.body as { plugins?: unknown } | null)?.plugins, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["NAME", "VERSION", "GRANTED", "COMPATIBLE"],
      rows: plugins.map((p) => [text(p.name), text(p.version), p.enabled ? "yes" : "no", p.compatible ? "yes" : "no"]),
      emptyMessage: "This deployment has no plugins installed.",
    })}\n`,
  );
}

// --- management API keys ----------------------------------------------------

interface ApiKeyRow {
  id: string;
  name: string;
  permissions: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
}

function apiKeysPath(org: string, rest = ""): string {
  return orgPath(org, `/api-keys${rest}`);
}

async function apiKeyList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "apikey list option");
  const { scope, org } = await readScope(deps, context);
  const path = apiKeysPath(org);
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const keys = expectArray<ApiKeyRow>((res.body as { keys?: unknown } | null)?.keys, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "NAME", "PERMISSIONS", "EXPIRES", "LAST USED"],
      rows: keys.map((key) => [
        text(key.id),
        text(key.name),
        String((key.permissions ?? []).length),
        text(key.expiresAt),
        text(key.lastUsedAt),
      ]),
      emptyMessage: `Organisation ${org} has no management API keys.`,
    })}\n`,
  );
}

async function apiKeyPermissions(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "apikey permissions option");
  const { scope, org } = await readScope(deps, context);
  const path = apiKeysPath(org, "/permissions");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const permissions = expectArray<string>((res.body as { permissions?: unknown } | null)?.permissions, `GET ${path}`);
  deps.io.stdout(`${[...permissions].sort().join("\n")}\n`);
}

function permissionList(options: readonly string[], flag: string): string[] {
  const value = takeValue(options, flag);
  if (value === undefined) return [];
  const keys = value.split(",").map((key) => key.trim()).filter((key) => key.length > 0);
  if (keys.length === 0) throw new ConfigError(`${flag} needs at least one permission key.`);
  return keys;
}

/** The ceiling a key may be issued, checked locally so a typo names itself. */
async function assertGrantable(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  org: string,
  permissions: readonly string[],
): Promise<void> {
  const path = apiKeysPath(org, "/permissions");
  const res = await call(deps, scope, { path });
  const known = new Set(expectArray<string>((res.body as { permissions?: unknown } | null)?.permissions, `GET ${path}`));
  const unknown = permissions.filter((permission) => !known.has(permission));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Not issuable in ${org}: ${unknown.join(", ")}. Run "polyant-cli apikey permissions" for the full set.`,
    );
  }
}

async function apiKeyCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const name = requirePositional(args, "apikey create", "name");
  const options = args.slice(1);
  assertKnown(options, { value: ["--permissions", "--expires-at", "--confirm"] }, "apikey create option");
  const permissions = permissionList(options, "--permissions");
  if (permissions.length === 0) throw new ConfigError("polyant-cli apikey create needs --permissions <key,key>.");
  const expiresAt = takeValue(options, "--expires-at");

  const { scope, org } = await readScope(deps, context);
  await assertGrantable(deps, scope, org, permissions);

  const plan = {
    title: `Issue management API key ${name}`,
    changes: [
      `Create a key named ${JSON.stringify(name)} in ${org}.`,
      `Grant: ${permissions.join(", ")}.`,
      expiresAt === undefined ? "No expiry: the key is valid until deleted." : `Expires at ${expiresAt}.`,
      "The token is shown once, on stdout. The engine stores only its bcrypt hash and cannot show it again.",
    ],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "POST",
    path: apiKeysPath(org),
    body: { name, permissions, ...(expiresAt === undefined ? {} : { expiresAt }) },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const token = (res.body as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new ConfigError(`POST ${apiKeysPath(org)} answered without a token — the key may still have been created.`);
  }
  // The one place this value will ever exist. On stdout alone, so `… > key.txt`
  // captures the token and nothing else; the recap goes to stderr.
  deps.io.stderr(`Issued ${name}. Store the token now — it cannot be shown again.\n`);
  deps.io.stdout(`${token}\n`);
}

async function apiKeyUpdate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const keyId = requirePositional(args, "apikey update", "key id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--name", "--permissions", "--expires-at", "--confirm"] }, "apikey update option");
  const name = takeValue(options, "--name");
  const permissions = permissionList(options, "--permissions");
  const expiresAt = takeValue(options, "--expires-at");
  if (name === undefined && permissions.length === 0 && expiresAt === undefined) {
    throw new ConfigError("polyant-cli apikey update needs --name, --permissions or --expires-at.");
  }

  const { scope, org } = await readScope(deps, context);
  if (permissions.length > 0) await assertGrantable(deps, scope, org, permissions);

  const changes = [
    ...(name === undefined ? [] : [`Rename to ${JSON.stringify(name)}.`]),
    ...(permissions.length === 0 ? [] : [`Replace the permission set with: ${permissions.join(", ")}.`]),
    ...(expiresAt === undefined ? [] : [`Set the expiry to ${expiresAt}.`]),
  ];
  if (!(await preflight(deps, scope, org, context, options, { title: `Update API key ${keyId}`, changes }))) return;

  const res = await call(deps, scope, {
    method: "PATCH",
    path: apiKeysPath(org, `/${encodeURIComponent(keyId)}`),
    body: {
      ...(name === undefined ? {} : { name }),
      ...(permissions.length === 0 ? {} : { permissions }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  });
  report(deps, context, res.raw, `Updated API key ${keyId}.`);
}

async function apiKeyDelete(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const keyId = requirePositional(args, "apikey delete", "key id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "apikey delete option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Delete management API key ${keyId}`,
    changes: [
      `Revoke ${keyId} in ${org}. Anything presenting it starts answering 401 immediately.`,
      "There is no undo: the token cannot be reissued, only replaced.",
    ],
    destructive: { confirm: keyId },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: apiKeysPath(org, `/${encodeURIComponent(keyId)}`) });
  report(deps, context, res.raw, `Deleted API key ${keyId}.`);
}

// --- membership: organisation role and workspace bindings -------------------

async function memberSetRole(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const userId = requirePositional(args, "member set-role", "user id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--role", "--confirm"] }, "member set-role option");
  const roleKey = takeValue(options, "--role");
  if (roleKey === undefined) throw new ConfigError("polyant-cli member set-role needs --role <key>.");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Set ${userId}'s role in ${org}`,
    changes: [`Assign role ${roleKey} at the organisation scope.`],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "PUT",
    path: orgPath(org, `/members/${encodeURIComponent(userId)}`),
    body: { roleKey },
  });
  report(deps, context, res.raw, `Set ${userId} to ${roleKey} in ${org}.`);
}

interface BindingRow {
  userId: string;
  workspaceId: string;
  roleKey: string;
}

/**
 * Workspace bindings are what actually decide a workspace-scoped permission, so
 * the listing resolves each workspace id back to its slug: the engine returns
 * ids, and an operator addresses workspaces by slug everywhere else.
 */
async function workspaceBindings(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "workspace bindings option");
  const { scope, org } = await readScope(deps, context);
  const path = orgPath(org, "/workspace-bindings");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const bindings = expectArray<BindingRow>((res.body as { bindings?: unknown } | null)?.bindings, `GET ${path}`);
  const workspaces = await call(deps, scope, { path: orgPath(org, "/workspaces") });
  const slugById = new Map(
    expectArray<{ id: string; slug: string }>(
      (workspaces.body as { workspaces?: unknown } | null)?.workspaces,
      `GET ${orgPath(org, "/workspaces")}`,
    ).map((ws) => [ws.id, ws.slug]),
  );

  deps.io.stdout(
    `${renderTable({
      headers: ["WORKSPACE", "USER ID", "ROLE"],
      rows: bindings.map((b) => [slugById.get(b.workspaceId) ?? b.workspaceId, text(b.userId), text(b.roleKey)]),
      emptyMessage: `Organisation ${org} has no workspace-scoped bindings.`,
    })}\n`,
  );
}

async function workspaceMemberSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requirePositional(args, "workspace member set", "workspace slug");
  const userId = requirePositional(args.slice(1), "workspace member set", "user id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--role", "--confirm"] }, "workspace member set option");
  const roleKey = takeValue(options, "--role");
  if (roleKey === undefined) throw new ConfigError("polyant-cli workspace member set needs --role <key>.");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Bind ${userId} to workspace ${slug}`,
    changes: [`Assign role ${roleKey} to ${userId}, scoped to ${slug} alone.`],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const workspaceId = await workspaceIdFor(deps, scope, org, slug);
  const res = await call(deps, scope, {
    method: "PUT",
    path: orgPath(org, `/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}`),
    body: { roleKey },
  });
  report(deps, context, res.raw, `Bound ${userId} to ${slug} as ${roleKey}.`);
}

async function workspaceMemberRemove(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requirePositional(args, "workspace member remove", "workspace slug");
  const userId = requirePositional(args.slice(1), "workspace member remove", "user id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "workspace member remove option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Unbind ${userId} from workspace ${slug}`,
    changes: [`Remove ${userId}'s ${slug}-scoped role. Their organisation-scope role, if any, is untouched.`],
    destructive: { confirm: userId },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const workspaceId = await workspaceIdFor(deps, scope, org, slug);
  const res = await call(deps, scope, {
    method: "DELETE",
    path: orgPath(org, `/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}`),
  });
  report(deps, context, res.raw, `Unbound ${userId} from ${slug}.`);
}

// --- the nodes these families contribute ------------------------------------

const EE_NOTE =
  "Enterprise: the engine gates this behind a licensed feature and answers 403 on a\ndeployment without it, the same shape as a missing permission.";

/** Subtrees merged into the `org`, `workspace` and `member` families in admin.ts. */
export const ORG_FAMILY_EXTRAS: Record<string, Record<string, Node>> = {
  org: {
    secrets: {
      show: {
        summary: "list the provider credentials shared across the organisation",
        usage: `Usage: polyant-cli org secrets show [--configured-only]\n\nPresence only — the engine never serves a value. ${ORG_NOTE}`,
        action: orgSecretsShow,
      },
      set: {
        summary: "set one shared provider credential from a file or stdin",
        usage: `Usage: polyant-cli org secrets set --key <name> --file <path|->

An agent's own secret wins; this one is the fallback, so setting it here changes
every agent in the organisation that does not have its own. The value is read
from a file or stdin, never a flag, and is never printed. ${ORG_NOTE}`,
        action: orgSecretsSet,
        mutates: true,
      },
      unset: {
        summary: "remove one shared provider credential",
        usage: `Usage: polyant-cli org secrets unset --key <name> --yes --confirm <name>\n\n${ORG_NOTE}`,
        action: orgSecretsUnset,
        mutates: true,
      },
    },
    plugins: {
      summary: "list the plugins installed here and which this organisation is granted",
      usage: `Usage: polyant-cli org plugins

An ungranted plugin is undiscoverable rather than merely inert: its tools and
hooks do not exist for this organisation's agents. Granting is a platform-admin
action, which a management key cannot perform. ${ORG_NOTE}`,
      action: orgPlugins,
    },
  },
  workspace: {
    bindings: {
      summary: "list every workspace-scoped role binding in the organisation",
      usage: `Usage: polyant-cli workspace bindings

A binding is what decides a workspace-scoped permission. Workspace ids are
resolved back to slugs. ${EE_NOTE} ${ORG_NOTE}`,
      action: workspaceBindings,
    },
    member: {
      set: {
        summary: "give a member a role in one workspace",
        usage: `Usage: polyant-cli workspace member set <workspaceSlug> <userId> --role <key>\n\n${EE_NOTE} ${ORG_NOTE}`,
        action: workspaceMemberSet,
        mutates: true,
      },
      remove: {
        summary: "remove a member's role in one workspace",
        usage: `Usage: polyant-cli workspace member remove <workspaceSlug> <userId> --yes --confirm <userId>\n\n${EE_NOTE} ${ORG_NOTE}`,
        action: workspaceMemberRemove,
        mutates: true,
      },
    },
  },
  member: {
    "set-role": {
      summary: "set a member's organisation-scope role",
      usage: `Usage: polyant-cli member set-role <userId> --role <key>

The organisation scope. For a role that applies in one workspace only, use
\`workspace member set\`. ${ORG_NOTE}`,
      action: memberSetRole,
      mutates: true,
    },
  },
};

/** The top-level `apikey` family: the CLI's own credential, administered. */
export const apiKeyFamily: Record<string, Node> = {
  list: {
    summary: "list the organisation's management API keys",
    usage: `Usage: polyant-cli apikey list\n\nNever the tokens — the engine stores only their hashes. ${EE_NOTE} ${ORG_NOTE}`,
    action: apiKeyList,
  },
  permissions: {
    summary: "list the permission keys a management API key may be issued",
    usage: `Usage: polyant-cli apikey permissions\n\nOne key per line, sorted, so it pipes into grep. ${ORG_NOTE}`,
    action: apiKeyPermissions,
  },
  create: {
    summary: "issue a management API key and print its token once",
    usage: `Usage: polyant-cli apikey create <name> --permissions <key,key> [--expires-at <iso>]

The token goes to stdout alone and is shown exactly once: the engine keeps only
its bcrypt hash and cannot reissue it. Every permission is checked against the
engine's issuable set first, so a typo fails naming the offending key.
${EE_NOTE} ${ORG_NOTE}`,
    action: apiKeyCreate,
    mutates: true,
  },
  update: {
    summary: "rename a key, replace its permissions, or change its expiry",
    usage: `Usage: polyant-cli apikey update <keyId> [--name <name>] [--permissions <key,key>] [--expires-at <iso>]

\`--permissions\` REPLACES the set rather than adding to it. ${EE_NOTE} ${ORG_NOTE}`,
    action: apiKeyUpdate,
    mutates: true,
  },
  delete: {
    summary: "revoke a management API key",
    usage: `Usage: polyant-cli apikey delete <keyId> --yes --confirm <keyId>\n\n${EE_NOTE} ${ORG_NOTE}`,
    action: apiKeyDelete,
    mutates: true,
  },
};
