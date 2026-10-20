// SPDX-License-Identifier: Apache-2.0
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
import { refusePersonalToken } from "../runtime/credential.js";
import type { ResolvedScope } from "../runtime/scope.js";

// --- organisation-level provider credentials --------------------------------

/**
 * The organisation's shared credentials. Same wire shape as an agent's
 * (`PutSecretsSchema` is shared by both routes in the engine), and the same
 * value-never-printed rule — but a different resolution order: an agent's own
 * secret wins, this one is the fallback, so ten agents on one account share one
 * key instead of ten. Since engine 1.2.0-ee a provider's key is not among them:
 * it lives in a connection (`providers.ts`, `provider-roles.ts`).
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
      `Shareable: ${secrets.map((secret) => secret.key).join(", ")}. ` +
      // Since engine 1.2.0-ee: listed only while a copy from before the upgrade is stored.
      "A model, embedding or speech provider key is no longer a secret: create a provider connection with " +
      "`org connections create`, lend it with `workspace connections assign`, and bind the role that uses it.",
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

/**
 * Every row is a plugin the organisation HOLDS. The engine used to list the
 * whole installation with an `enabled` flag; since 1.2.0 an ungranted plugin is
 * absent instead, so there is no grant column left to read.
 */
interface PluginRow {
  name: string;
  version: string;
  /** Present on a plugin baked into the image, absent on a marketplace one. */
  compatible?: boolean;
  /** Present on a marketplace plugin, absent on a baked one. */
  health?: string;
  /** Workspace listing only, on a marketplace plugin: `health === "ready"`. */
  available?: boolean;
}

type Availability = { runnable: true } | { runnable: false; reason: string } | { runnable: undefined };

/**
 * Whether the engine can run this row, read from whichever field the row
 * carries. The two kinds of plugin answer differently: one baked into the image
 * carries `compatible` (does this engine satisfy its range), one installed from
 * the marketplace carries `health` (did its release download, verify and stay
 * unrevoked) and no `compatible` at all. Reading only `compatible` made every
 * marketplace plugin look incompatible. A row carrying neither is reported as
 * unknown rather than guessed, so a field the engine adds later degrades to
 * "unknown" instead of to a false "no".
 */
function availabilityOf(row: PluginRow): Availability {
  if (row.compatible === false) return { runnable: false, reason: "incompatible" };
  if (typeof row.health === "string") {
    return row.health === "ready" ? { runnable: true } : { runnable: false, reason: row.health };
  }
  if (typeof row.available === "boolean") {
    return row.available ? { runnable: true } : { runnable: false, reason: "unavailable" };
  }
  if (row.compatible === true) return { runnable: true };
  return { runnable: undefined };
}

function availabilityCell(row: PluginRow): string {
  const availability = availabilityOf(row);
  if (availability.runnable === true) return "yes";
  if (availability.runnable === false) return `no (${availability.reason})`;
  return "unknown";
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
      headers: ["NAME", "VERSION", "AVAILABLE"],
      rows: plugins.map((p) => [text(p.name), text(p.version), availabilityCell(p)]),
      emptyMessage: `Organisation ${org} holds no plugins.`,
    })}\n`,
  );
}

/**
 * How an organisation comes to hold a plugin, which no management-key route
 * does: an Organization Admin installs a marketplace plugin from the web
 * console, and a Platform Admin grants a plugin baked into the image.
 */
const PLUGIN_HOLDING_NOTE =
  "An Organization Admin installs a marketplace plugin from the web console; a plugin baked into the image is granted by a Platform Admin.";

// --- workspace allow-lists: which skills and plugins a workspace may use ----

/**
 * These six routes take the workspace **slug** in the path, unlike
 * `/workspaces/:workspaceId/members` two sections up, which takes the uuid. So
 * there is deliberately no `workspaceIdFor` call here: resolving the slug to an
 * id first would build a path the engine does not serve.
 *
 * `:name` rather than `:slug` is the engine's choice and it is load-bearing
 * there — its permission guard treats any path param literally named `slug` as
 * an AGENT slug to resolve — but from here it is just the last segment.
 */
function assignmentPath(org: string, workspace: string, kind: "skills" | "plugins", name?: string): string {
  const base = orgPath(org, `/workspaces/${encodeURIComponent(workspace)}/${kind}`);
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

interface WorkspaceSkillRow {
  slug: string;
  name: string;
  assigned: boolean;
}

/** Only the plugins the organisation holds: one it does not hold is absent. */
interface WorkspacePluginRow extends PluginRow {
  assigned: boolean;
}

/**
 * The listing is the whole organisation catalogue with an `assigned` flag, not
 * the assigned subset — which is what makes it the right thing to validate a
 * name against before writing.
 */
async function assignableSkills(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  org: string,
  workspace: string,
): Promise<WorkspaceSkillRow[]> {
  const path = assignmentPath(org, workspace, "skills");
  const res = await call(deps, scope, { path });
  return expectArray<WorkspaceSkillRow>((res.body as { skills?: unknown } | null)?.skills, `GET ${path}`);
}

async function assignablePlugins(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  org: string,
  workspace: string,
): Promise<WorkspacePluginRow[]> {
  const path = assignmentPath(org, workspace, "plugins");
  const res = await call(deps, scope, { path });
  return expectArray<WorkspacePluginRow>((res.body as { plugins?: unknown } | null)?.plugins, `GET ${path}`);
}

/** Two positionals, so the second one gets the same flag-in-the-wrong-place check. */
function requirePair(args: readonly string[], action: string, what: string): { workspace: string; name: string } {
  const workspace = requirePositional(args, action, "workspace slug");
  const name = requirePositional(args.slice(1), action, what);
  return { workspace, name };
}

async function workspaceSkillsList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const workspace = requirePositional(args, "workspace skills list", "workspace slug");
  assertKnown(args.slice(1), { boolean: ["--assigned-only"] }, "workspace skills list option");
  const { scope, org } = await readScope(deps, context);
  const path = assignmentPath(org, workspace, "skills");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const all = expectArray<WorkspaceSkillRow>((res.body as { skills?: unknown } | null)?.skills, `GET ${path}`);
  const skills = args.includes("--assigned-only") ? all.filter((skill) => skill.assigned) : all;
  deps.io.stdout(
    `${renderTable({
      headers: ["SLUG", "NAME", "ASSIGNED"],
      rows: skills.map((skill) => [text(skill.slug), text(skill.name), skill.assigned ? "yes" : "no"]),
      emptyMessage: `Organisation ${org} has no skills to assign.`,
    })}\n`,
  );
}

async function workspaceSkillsAssign(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const { workspace, name } = requirePair(args, "workspace skills assign", "skill slug");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "workspace skills assign option");
  const { scope, org } = await readScope(deps, context);

  const catalogue = await assignableSkills(deps, scope, org, workspace);
  const skill = catalogue.find((entry) => entry.slug === name);
  if (skill === undefined) {
    throw new ConfigError(
      `Organisation ${org} has no skill ${JSON.stringify(name)}. ` +
        `Available: ${catalogue.map((entry) => entry.slug).join(", ") || "(none)"}.`,
    );
  }

  const changes = skill.assigned
    ? [`Leave ${name} assigned to ${workspace}; it already is.`]
    : [
        `Let ${workspace} use skill ${name}.`,
        "Agents in that workspace start resolving it. Elsewhere it stays invisible.",
      ];
  if (!(await preflight(deps, scope, org, context, options, { title: `Assign skill ${name} to ${workspace}`, changes }))) return;

  const res = await call(deps, scope, { method: "PUT", path: assignmentPath(org, workspace, "skills", name) });
  report(deps, context, res.raw, `Assigned skill ${name} to ${workspace}.`);
}

async function workspaceSkillsRevoke(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const { workspace, name } = requirePair(args, "workspace skills revoke", "skill slug");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "workspace skills revoke option");
  const { scope, org } = await readScope(deps, context);

  const catalogue = await assignableSkills(deps, scope, org, workspace);
  const skill = catalogue.find((entry) => entry.slug === name);
  if (skill === undefined) {
    throw new ConfigError(`Organisation ${org} has no skill ${JSON.stringify(name)}.`);
  }
  if (!skill.assigned) {
    // The engine answers 200 for an assignment it never held, so without this a
    // typo would report success while the real assignment stayed in place.
    throw new ConfigError(`Workspace ${workspace} is not assigned skill ${name}; there is nothing to revoke.`);
  }

  const plan = {
    title: `Revoke skill ${name} from ${workspace}`,
    changes: [
      `Stop ${workspace} using skill ${name}. Agents there stop resolving it on their next turn.`,
      "The skill itself, and its assignment to other workspaces, are untouched.",
    ],
    destructive: { confirm: name },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: assignmentPath(org, workspace, "skills", name) });
  report(deps, context, res.raw, `Revoked skill ${name} from ${workspace}.`);
}

async function workspacePluginsList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const workspace = requirePositional(args, "workspace plugins list", "workspace slug");
  assertKnown(args.slice(1), { boolean: ["--assigned-only"] }, "workspace plugins list option");
  const { scope, org } = await readScope(deps, context);
  const path = assignmentPath(org, workspace, "plugins");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const all = expectArray<WorkspacePluginRow>((res.body as { plugins?: unknown } | null)?.plugins, `GET ${path}`);
  const plugins = args.includes("--assigned-only") ? all.filter((plugin) => plugin.assigned) : all;
  deps.io.stdout(
    `${renderTable({
      headers: ["NAME", "VERSION", "ASSIGNED", "AVAILABLE"],
      rows: plugins.map((plugin) => [
        text(plugin.name),
        text(plugin.version),
        plugin.assigned ? "yes" : "no",
        availabilityCell(plugin),
      ]),
      emptyMessage: `Organisation ${org} holds no plugins.`,
    })}\n`,
  );
}

async function workspacePluginsAssign(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const { workspace, name } = requirePair(args, "workspace plugins assign", "plugin name");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "workspace plugins assign option");
  const { scope, org } = await readScope(deps, context);

  const held = await assignablePlugins(deps, scope, org, workspace);
  const plugin = held.find((entry) => entry.name === name);
  if (plugin === undefined) {
    // The listing stops at what the organisation holds, so "not installed" and
    // "not granted" are the same absence here — deliberately: the engine does
    // not tell a tenant what other tenants run. Either way the assignment would
    // be a row that changes nothing, and holding it is decided elsewhere.
    throw new ConfigError(
      `Organisation ${org} holds no plugin ${JSON.stringify(name)}, so assigning it to ${workspace} would change nothing. ` +
        `Held: ${held.map((entry) => entry.name).join(", ") || "(none)"}. ` +
        PLUGIN_HOLDING_NOTE,
    );
  }

  // Only a row that says it cannot run earns the warning: one that says nothing
  // either way is left to the engine, which refuses an unavailable plugin itself.
  const availability = availabilityOf(plugin);
  const changes = plugin.assigned
    ? [`Leave ${name} assigned to ${workspace}; it already is.`]
    : [
        `Let ${workspace} use plugin ${name} (${plugin.version}).`,
        ...(availability.runnable === false
          ? [`The engine reports this plugin ${availability.reason}, so it will refuse the assignment until that changes.`]
          : []),
        "Its tools and hooks appear to agents in that workspace. Elsewhere they stay undiscoverable.",
      ];
  if (!(await preflight(deps, scope, org, context, options, { title: `Assign plugin ${name} to ${workspace}`, changes }))) return;

  const res = await call(deps, scope, { method: "PUT", path: assignmentPath(org, workspace, "plugins", name) });
  report(deps, context, res.raw, `Assigned plugin ${name} to ${workspace}.`);
}

async function workspacePluginsRevoke(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const { workspace, name } = requirePair(args, "workspace plugins revoke", "plugin name");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "workspace plugins revoke option");
  const { scope, org } = await readScope(deps, context);

  const held = await assignablePlugins(deps, scope, org, workspace);
  const plugin = held.find((entry) => entry.name === name);
  if (plugin === undefined) {
    throw new ConfigError(`Organisation ${org} holds no plugin ${JSON.stringify(name)}.`);
  }
  if (!plugin.assigned) {
    throw new ConfigError(`Workspace ${workspace} is not assigned plugin ${name}; there is nothing to revoke.`);
  }

  const plan = {
    title: `Revoke plugin ${name} from ${workspace}`,
    changes: [
      `Stop ${workspace} using plugin ${name}. Its tools and hooks become undiscoverable to agents there.`,
      "An agent configured to use one of those tools keeps the configuration and loses the tool.",
    ],
    destructive: { confirm: name },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: assignmentPath(org, workspace, "plugins", name) });
  report(deps, context, res.raw, `Revoked plugin ${name} from ${workspace}.`);
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
  refusePersonalToken(scope, "apikey create");
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
  refusePersonalToken(scope, "apikey update");
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

const ASSIGN_NOTE =
  "An allow-list, not a grant: what a workspace may use is the INTERSECTION of\n" +
  "the organisation's grant and this assignment. An admin bound only to the\n" +
  "workspace being restricted is refused — the list must not be liftable by the\n" +
  "person it restricts — so this needs an organisation-scope binding. The path\n" +
  "takes the workspace SLUG here, unlike \"workspace member\", which takes its id.";

const EE_NOTE =
  "Enterprise: the engine gates this behind a licensed feature and answers 403 on a\ndeployment without it, the same shape as a missing permission.";

/** Subtrees merged into the `org`, `workspace` and `member` families in admin.ts. */
export const ORG_FAMILY_EXTRAS: Record<string, Record<string, Node>> = {
  org: {
    secrets: {
      show: {
        summary: "list the credentials shared across the organisation",
        usage: `Usage: polyant-cli org secrets show [--configured-only]

Presence only — the engine never serves a value. Since engine 1.2.0-ee a
provider's key lives in a connection (\`org connections\`); a copy the upgrade
left behind is listed only while it is stored, so it can be removed. ${ORG_NOTE}`,
        action: orgSecretsShow,
      },
      set: {
        summary: "set one shared credential from a file or stdin",
        usage: `Usage: polyant-cli org secrets set --key <name> --file <path|->

An agent's own secret wins; this one is the fallback, so setting it here changes
every agent in the organisation that does not have its own. The value is read
from a file or stdin, never a flag, and is never printed. A provider key is
refused by the engine with a 400 naming the connection routes: it belongs in
\`org connections create\`. ${ORG_NOTE}`,
        action: orgSecretsSet,
        mutates: true,
      },
      unset: {
        summary: "remove one shared credential",
        usage: `Usage: polyant-cli org secrets unset --key <name> --yes --confirm <name>\n\n${ORG_NOTE}`,
        action: orgSecretsUnset,
        mutates: true,
      },
    },
    plugins: {
      summary: "list the plugins this organisation holds",
      usage: `Usage: polyant-cli org plugins

Only the plugins the organisation holds. One it was not granted is absent rather
than listed as ungranted: its tools and hooks do not exist for this
organisation's agents, and the engine does not name what other tenants run.
${PLUGIN_HOLDING_NOTE} A management key can do neither.

AVAILABLE is whether the engine can run the plugin for this organisation: for a
plugin baked into the image, whether this engine satisfies its range; for a
marketplace plugin, the health of the installed release (\`no (revoked)\`,
\`no (unavailable)\`). \`unknown\` means the row carried neither.

This is the organisation's half of the decision. The workspace's half is
\`workspace plugins list\`, and an agent sees a plugin only when both say yes.

The permission is \`org.plugin:read\`, which used to be the \`org:read\` floor: a key
issued before that split, holding only \`org:read\`, now answers 403 here.
${ORG_NOTE}`,
      action: orgPlugins,
    },
  },
  workspace: {
    skills: {
      list: {
        summary: "list the organisation's skills and which this workspace may use",
        usage: `Usage: polyant-cli workspace skills list <workspaceSlug> [--assigned-only]

The whole organisation catalogue with an ASSIGNED column, not the assigned
subset: a skill missing from the workspace is the answer to "why does the agent
not have it". ${ASSIGN_NOTE} ${ORG_NOTE}`,
        action: workspaceSkillsList,
      },
      assign: {
        summary: "let one workspace use a skill",
        usage: `Usage: polyant-cli workspace skills assign <workspaceSlug> <skillSlug>

The slug is checked against the organisation's catalogue first, so a typo fails
naming the available skills rather than as a 404. ${ASSIGN_NOTE} ${ORG_NOTE}`,
        action: workspaceSkillsAssign,
        mutates: true,
      },
      revoke: {
        summary: "stop one workspace using a skill",
        usage: `Usage: polyant-cli workspace skills revoke <workspaceSlug> <skillSlug> --yes --confirm <skillSlug>

Agents in that workspace stop resolving the skill on their next turn. The skill
itself, and its assignment elsewhere, are untouched. ${ORG_NOTE}`,
        action: workspaceSkillsRevoke,
        mutates: true,
      },
    },
    plugins: {
      list: {
        summary: "list the organisation's plugins and which this workspace may use",
        usage: `Usage: polyant-cli workspace plugins list <workspaceSlug> [--assigned-only]

The plugins the organisation holds, with ASSIGNED for this workspace's half: a
plugin needs both to be visible to an agent. AVAILABLE is whether the engine can
run it, as in \`org plugins\`. ${ASSIGN_NOTE} ${ORG_NOTE}`,
        action: workspacePluginsList,
      },
      assign: {
        summary: "let one workspace use a plugin",
        usage: `Usage: polyant-cli workspace plugins assign <workspaceSlug> <name>

Refused locally when the organisation does not hold the plugin: the assignment
would be a row that changes nothing, because visibility is the intersection of
the two. The engine lists only held plugins, so a name it does not show may be
ungranted or not installed at all. ${PLUGIN_HOLDING_NOTE}
${ORG_NOTE}`,
        action: workspacePluginsAssign,
        mutates: true,
      },
      revoke: {
        summary: "stop one workspace using a plugin",
        usage: `Usage: polyant-cli workspace plugins revoke <workspaceSlug> <name> --yes --confirm <name>

The plugin's tools and hooks become undiscoverable to agents in that workspace.
An agent configured to use one of them keeps the configuration and loses the
tool. ${ORG_NOTE}`,
        action: workspacePluginsRevoke,
        mutates: true,
      },
    },
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
\`workspace member set\`.

The user must already belong to the organisation: where invitations are
licensed the engine refuses anyone else, and they join through
\`member invitations create\`, with the role set on acceptance. ${ORG_NOTE}`,
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
A personal token is refused (engine 1.2.0): a credential that can mint another
outlives its own revocation. Use a management key or the web console.
${EE_NOTE} ${ORG_NOTE}`,
    action: apiKeyCreate,
    mutates: true,
  },
  update: {
    summary: "rename a key, replace its permissions, or change its expiry",
    usage: `Usage: polyant-cli apikey update <keyId> [--name <name>] [--permissions <key,key>] [--expires-at <iso>]

\`--permissions\` REPLACES the set rather than adding to it. A personal token is
refused, as for \`apikey create\`. ${EE_NOTE} ${ORG_NOTE}`,
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
