// SPDX-License-Identifier: Apache-2.0
import type { RoleSummary, RolesResponse, WorkspaceSummary, WorkspacesResponse } from "../api/types.js";
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writeRawResponse } from "../render/output.js";
import { confirmMutation, type MutationPlan } from "./confirm.js";
import { takeValue } from "./flags.js";
import { call, expectArray, scopeFor, wantsJson, type ServiceDependencies } from "./service.js";
import type { ResolvedScope } from "./scope.js";

/**
 * What every organisation-scoped command family needs. Administration is
 * org-scoped, not workspace-scoped: the organisation is a path segment, so it
 * must be known before a path is assembled. A management key belongs to exactly
 * one organisation and `/api/service-context` reports it, so `--org` is a way to
 * be explicit rather than a thing to look up.
 */
export async function orgFor(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  context: CommandContext | undefined,
): Promise<string> {
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

export function orgPath(org: string, rest = ""): string {
  return `/api/organizations/${encodeURIComponent(org)}${rest}`;
}

function planScope(scope: ResolvedScope, org: string): MutationPlan["scope"] {
  return { target: scope.target.name, prod: scope.target.prod, org };
}

export async function preflight(
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
export async function readScope(deps: ServiceDependencies, context: CommandContext | undefined) {
  const scope = await scopeFor(deps, context, "read");
  return { scope, org: await orgFor(deps, scope, context) };
}

export function report(deps: ServiceDependencies, context: CommandContext | undefined, raw: string, message: string): void {
  if (wantsJson(context)) return writeRawResponse(deps.io, raw);
  deps.io.stdout(`${message}\n`);
}

/** The first positional argument, refusing a flag that landed where a name belongs. */
export function requirePositional(args: readonly string[], action: string, what = "slug"): string {
  const value = args[0];
  if (value === undefined || value.startsWith("--")) throw new ConfigError(`polyant-cli ${action} needs a ${what}.`);
  return value;
}

export const ORG_NOTE = "The organisation comes from the key when --org is absent.";

/**
 * `PATCH/DELETE /workspaces/:workspaceId` matches on the uuid, never on the slug,
 * so the id has to come off the collection first — there is no lookup by slug.
 */
export async function workspaceIdFor(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  org: string,
  slug: string,
): Promise<string> {
  const path = orgPath(org, "/workspaces");
  const res = await call(deps, scope, { path });
  const workspaces = expectArray<WorkspaceSummary>((res.body as Partial<WorkspacesResponse> | null)?.workspaces, `GET ${path}`);
  const found = workspaces.find((ws) => ws.slug === slug || ws.id === slug);
  if (found === undefined) throw new ConfigError(`Organisation ${org} has no workspace ${JSON.stringify(slug)}.`);
  return found.id;
}

/** Same for `DELETE /roles/:roleId`: the path takes the uuid, not the role key. */
export async function roleIdFor(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  org: string,
  key: string,
): Promise<string> {
  const path = orgPath(org, "/roles");
  const res = await call(deps, scope, { path });
  const roles = expectArray<RoleSummary>((res.body as Partial<RolesResponse> | null)?.roles, `GET ${path}`);
  const found = roles.find((role) => role.key === key || role.id === key);
  if (found === undefined) throw new ConfigError(`Organisation ${org} has no custom role ${JSON.stringify(key)}.`);
  return found.id;
}
