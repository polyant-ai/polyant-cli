// SPDX-License-Identifier: Apache-2.0
import type { ApiResponse } from "../api/client.js";
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writeRawResponse } from "../render/output.js";
import { confirmMutation, type MutationPlan } from "./confirm.js";
import { takeValue } from "./flags.js";
import { wantsJson, type ServiceDependencies } from "./service.js";
import type { ResolvedScope } from "./scope.js";

/**
 * What every agent (workspace-scoped) command family needs. The counterpart of
 * `runtime/org.ts`: an agent lives in a workspace, which the scope already
 * carries, so nothing has to be resolved before a path is assembled.
 */
function planScope(scope: ResolvedScope): MutationPlan["scope"] {
  return {
    target: scope.target.name,
    prod: scope.target.prod,
    ...(scope.org === undefined ? {} : { org: scope.org }),
    ...(scope.workspace === undefined ? {} : { workspace: scope.workspace }),
  };
}

export async function preflight(
  deps: ServiceDependencies,
  scope: ResolvedScope,
  context: CommandContext | undefined,
  args: readonly string[],
  plan: Omit<MutationPlan, "scope">,
): Promise<boolean> {
  const confirm = takeValue(args, "--confirm");
  const decision = await confirmMutation(
    { ...plan, scope: planScope(scope) },
    {
      yes: context?.global.yes ?? false,
      dryRun: context?.global.dryRun ?? false,
      ...(confirm === undefined ? {} : { confirm }),
    },
    deps.io,
  );
  return decision.shouldWrite;
}

export function requireSlug(args: readonly string[], action: string): string {
  const slug = args[0];
  if (slug === undefined || slug.startsWith("--")) throw new ConfigError(`polyant-cli agent ${action} needs an agent slug.`);
  return slug;
}

/** A second positional, for the routes addressing a thing inside an agent. */
export function requireSecond(args: readonly string[], action: string, what: string): string {
  const value = args[1];
  if (value === undefined || value.startsWith("--")) throw new ConfigError(`polyant-cli agent ${action} needs a ${what}.`);
  return value;
}

export function reportWrite(
  deps: ServiceDependencies,
  context: CommandContext | undefined,
  res: ApiResponse,
  message: string,
): void {
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);
  deps.io.stdout(`${message}\n`);
}

export function agentPath(slug: string, rest = ""): string {
  return `/api/instances/${encodeURIComponent(slug)}${rest}`;
}
