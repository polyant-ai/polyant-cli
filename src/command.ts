// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise

/**
 * One command. Kept in its own module so a command never has to import
 * `cli.ts`, which would make the command table an import cycle.
 */
export interface Command {
  /** One line, shown in `polyant --help`. */
  readonly summary: string;
  /** Full usage block, shown by `polyant <command> --help`. */
  readonly usage: string;
  /** `argv` with the command name already removed. Throws `CliError` to set the exit code. */
  run(argv: string[]): Promise<void>;
}
