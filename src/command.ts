// SPDX-License-Identifier: Apache-2.0
import type { GlobalOptions } from "./runtime/global-options.js";

/** Normalized process-wide options made available to a resolved command. */
export interface CommandContext {
  readonly path: string[];
  readonly global: GlobalOptions;
}

/**
 * One command node. Kept in its own module so a command never has to import
 * `cli.ts`, which would make the command tree an import cycle.
 */
export interface Command {
  /** One line, shown in parent help. */
  readonly summary: string;
  /** Full usage block, shown by `polyant-cli <command> --help`. */
  readonly usage: string;
  /** Children for resource families such as `agent`. */
  readonly children?: Record<string, Command>;
  /** Whether this command owns dry-run semantics and may receive `--dry-run`. */
  readonly supportsDryRun?: boolean;
  /**
   * `argv` with the resolved command path and global flags removed. The
   * optional context keeps direct command tests and callers source-compatible
   * while the top-level runtime can pass normalized global options.
   */
  run?(argv: string[], context?: CommandContext): Promise<void>;
}
