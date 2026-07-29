// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { ConfigError } from "../exit.js";
import type { OutputIO } from "../render/output.js";

export interface MutationPlan {
  title: string;
  scope: { target: string; prod: boolean; org?: string; workspace?: string };
  changes: readonly string[];
  destructive?: { confirm: string };
}

/** The subset of global command options that affects a write preflight. */
export interface ConfirmationOptions {
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly confirm?: string;
}

/**
 * Process interaction is injected so this policy remains free of terminal and
 * network dependencies. Callers can bridge this to readline when needed.
 */
export interface ConfirmationIO extends OutputIO {
  readonly interactive: boolean;
  prompt(message: string): Promise<string>;
}

/** A caller performs its write only when `shouldWrite` is true. */
export interface MutationDecision {
  readonly shouldWrite: boolean;
}

function renderRecap(plan: MutationPlan): string {
  const scope = [
    `target: ${plan.scope.target}${plan.scope.prod ? " (PROD)" : ""}`,
    ...(plan.scope.org === undefined ? [] : [`org: ${plan.scope.org}`]),
    ...(plan.scope.workspace === undefined ? [] : [`workspace: ${plan.scope.workspace}`]),
  ];
  const changes = plan.changes.length === 0 ? ["  - No changes specified."] : plan.changes.map((change) => `  - ${change}`);
  return [plan.title, ...scope, "changes:", ...changes].join("\n");
}

function reject(message: string): never {
  throw new ConfigError(message);
}

/**
 * Emits a mutation recap then decides whether the caller may perform its
 * write. It intentionally performs no remote work itself.
 */
export async function confirmMutation(
  plan: MutationPlan,
  options: ConfirmationOptions,
  io: ConfirmationIO,
): Promise<MutationDecision> {
  io.stderr(`${renderRecap(plan)}\n`);

  if (options.dryRun) {
    io.stderr("dry-run: no changes will be written.\n");
    return { shouldWrite: false };
  }

  if (plan.destructive !== undefined) {
    if (!options.yes) reject(`${plan.title} is destructive; --yes is required.`);
    if (options.confirm !== plan.destructive.confirm) {
      reject(`${plan.title} is destructive; --confirm ${plan.destructive.confirm} is required.`);
    }
    return { shouldWrite: true };
  }

  if (plan.scope.prod && !options.yes) reject(`${plan.title} targets production; --yes is required.`);
  if (!io.interactive && !options.yes) reject(`${plan.title} is non-interactive; --yes is required.`);
  if (options.yes) return { shouldWrite: true };

  const answer = await io.prompt("Proceed? [y/N] ");
  if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
    reject(`${plan.title} was not confirmed.`);
  }
  return { shouldWrite: true };
}
