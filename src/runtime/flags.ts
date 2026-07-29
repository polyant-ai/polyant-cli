// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { ConfigError } from "../exit.js";

/**
 * Command-local flag reading. `parseArgs` is not used here because a command
 * subtree accepts different flags per action, and its strict mode would have to
 * be re-declared per branch; these two helpers keep each branch's accepted set
 * next to the branch itself.
 */

/** Reads `--flag value`, rejecting a flag that swallowed the next option. */
export function takeValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new ConfigError(`${flag} needs a value.`);
  return value;
}

export interface AcceptedFlags {
  /** Flags of the form `--flag value`. */
  readonly value?: readonly string[];
  /** Flags whose presence alone is the value. */
  readonly boolean?: readonly string[];
}

/** Rejects any option outside the accepted set, so a typo never passes silently. */
export function assertKnown(args: readonly string[], accepted: AcceptedFlags, label = "option"): void {
  const values = accepted.value ?? [];
  const booleans = accepted.boolean ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    if (booleans.includes(arg)) continue;
    if (!values.includes(arg)) throw new ConfigError(`Unknown ${label} ${arg}.`);
    index += 1;
  }
}
