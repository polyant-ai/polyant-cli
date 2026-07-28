// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { CliError, ExitCode, type ExitCodeValue } from "./exit.js";
import type { Command } from "./command.js";

/**
 * The command table. Later tasks add their entry here explicitly rather than
 * registering by import side effect: an explicit table has no cycles and is
 * greppable.
 */
export const COMMANDS: Record<string, Command> = {};

export function renderHelp(): string {
  const names = Object.keys(COMMANDS).sort();
  const lines = [
    "polyant — configure a Polyant instance as code",
    "",
    "Usage: polyant <command> [args]",
    "",
    "Commands:",
  ];
  if (names.length === 0) lines.push("  (none registered)");
  for (const name of names) lines.push(`  ${name.padEnd(10)} ${COMMANDS[name].summary}`);
  lines.push("", "Run `polyant <command> --help` for a command's usage.");
  return lines.join("\n");
}

/**
 * Resolves argv to an exit code. Never throws and never calls `process.exit`,
 * so tests can assert on the returned code.
 */
export async function run(argv: string[]): Promise<ExitCodeValue> {
  const [name, ...rest] = argv;

  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    process.stdout.write(`${renderHelp()}\n`);
    return ExitCode.Ok;
  }

  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(`Unknown command "${name}".\n\n${renderHelp()}\n`);
    return ExitCode.Config;
  }

  try {
    await command.run(rest);
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      return error.code;
    }
    // Anything else is a bug in the CLI, not a state the caller can act on.
    // There is no exit code for "tool defect", so it reports as a config
    // failure but is labelled so it is never mistaken for one.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Internal error: ${reason}\n`);
    return ExitCode.Config;
  }
}
