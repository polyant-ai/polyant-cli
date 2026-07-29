// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { Command } from "./command.js";
import { agentCommand } from "./commands/agent.js";
import { analyticsCommand } from "./commands/analytics.js";
import { apiCommand } from "./commands/api.js";
import { configCommand } from "./commands/config.js";
import { monitorCommand } from "./commands/monitor.js";
import { whoamiCommand } from "./commands/whoami.js";
import { CliError, ConfigError, ExitCode, type ExitCodeValue } from "./exit.js";
import { parseInvocation, type Invocation } from "./runtime/global-options.js";

/**
 * The command tree. Later tasks add their entry here explicitly rather than
 * registering by import side effect: an explicit tree has no cycles and is
 * greppable.
 */
export const COMMANDS: Record<string, Command> = {
  agent: agentCommand,
  analytics: analyticsCommand,
  api: apiCommand,
  config: configCommand,
  monitor: monitorCommand,
  whoami: whoamiCommand,
};

function childCommand(command: Command, name: string): Command | undefined {
  const children = command.children;
  return children !== undefined && Object.hasOwn(children, name) ? children[name] : undefined;
}

function rootCommand(name: string): Command | undefined {
  return Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
}

function renderChildren(command: Command, heading: string): string[] {
  const names = Object.keys(command.children ?? {}).sort();
  const lines = [heading];
  if (names.length === 0) lines.push("  (none registered)");
  // Width from the actual names: a fixed column silently misaligns as soon as a
  // command name outgrows it.
  const width = Math.max(0, ...names.map((name) => name.length));
  for (const name of names) {
    const child = childCommand(command, name);
    if (child !== undefined) lines.push(`  ${name.padEnd(width)}  ${child.summary}`);
  }
  return lines;
}

export function renderHelp(): string {
  const lines = [
    "polyant-cli — configure a Polyant instance as code",
    "",
    "Usage: polyant-cli <command> [args]",
    "",
    ...renderChildren({ summary: "root", usage: "", children: COMMANDS }, "Commands:"),
    "",
    "Run `polyant-cli <command> --help` for a command's usage.",
  ];
  return lines.join("\n");
}

function renderCommandHelp(command: Command, path: string[]): string {
  const lines = [command.usage];
  if (command.children !== undefined) {
    lines.push("", ...renderChildren(command, "Actions:"), "", `Run \`polyant-cli ${path.join(" ")} <action> --help\` for an action's usage.`);
  }
  return lines.join("\n");
}

function resolveCommand(path: string[]): Command {
  const root = rootCommand(path[0]);
  if (root === undefined) throw new ConfigError(`Unknown command "${path[0]}".`);

  let command = root;
  for (const segment of path.slice(1)) {
    const child = childCommand(command, segment);
    if (child === undefined) throw new ConfigError(`Unknown command "${path.join(" ")}".`);
    command = child;
  }
  return command;
}

function isHelpRequested(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h") || args[0] === "help";
}

function isGroupHelpRequest(args: string[]): boolean {
  return args[0] === "--help" || args[0] === "-h" || args[0] === "help";
}

function reportError(error: unknown): ExitCodeValue {
  if (error instanceof CliError) {
    const help = error.message.startsWith("Unknown command ") ? `\n\n${renderHelp()}` : "";
    process.stderr.write(`${error.message}${help}\n`);
    return error.code;
  }
  // Anything else is a bug in the CLI, not a state the caller can act on.
  // There is no exit code for "tool defect", so it reports as a config
  // failure but is labelled so it is never mistaken for one.
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Internal error: ${reason}\n`);
  return ExitCode.Config;
}

function reportMissingAction(invocation: Invocation, command: Command): never {
  const candidate = invocation.args[0];
  if (candidate !== undefined) {
    throw new ConfigError(`Unknown command "${[...invocation.path, candidate].join(" ")}".\n\n${renderCommandHelp(command, invocation.path)}`);
  }
  throw new ConfigError(`Missing action for "${invocation.path.join(" ")}".\n\n${renderCommandHelp(command, invocation.path)}`);
}

/**
 * Resolves argv to an exit code. Never throws and never calls `process.exit`,
 * so tests can assert on the returned code.
 */
export async function run(argv: string[]): Promise<ExitCodeValue> {
  try {
    const invocation = parseInvocation(argv, COMMANDS);
    if (invocation.path.length === 0) {
      process.stdout.write(`${renderHelp()}\n`);
      return ExitCode.Ok;
    }

    const command = resolveCommand(invocation.path);
    if (command.children !== undefined && invocation.args.length > 0 && !isGroupHelpRequest(invocation.args)) {
      return reportMissingAction(invocation, command);
    }
    if (invocation.global.dryRun && command.supportsDryRun !== true) {
      throw new ConfigError(`--dry-run is not supported by "polyant-cli ${invocation.path.join(" ")}".`);
    }
    if (isHelpRequested(invocation.args)) {
      process.stdout.write(`${renderCommandHelp(command, invocation.path)}\n`);
      return ExitCode.Ok;
    }
    if (command.run === undefined) return reportMissingAction(invocation, command);

    await command.run(invocation.args, { path: invocation.path, global: invocation.global });
    return ExitCode.Ok;
  } catch (error) {
    return reportError(error);
  }
}
