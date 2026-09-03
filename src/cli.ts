// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { readFileSync } from "node:fs";
import type { Command } from "./command.js";
import { agentCommand } from "./commands/agent.js";
import { adminCommands } from "./commands/admin.js";
import { analyticsCommand } from "./commands/analytics.js";
import { apiCommand } from "./commands/api.js";
import { configCommand } from "./commands/config.js";
import { devCommand } from "./commands/dev.js";
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
  dev: devCommand,
  monitor: monitorCommand,
  // org, workspace, member, role — organisation administration, which the design
  // spec exposes as top-level families rather than under one `admin` prefix.
  ...adminCommands,
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
    "  --version    print the version and exit",
    "  --help --json  print the whole command tree as JSON, for an agent",
    "",
    ...renderChildren({ summary: "root", usage: "", children: COMMANDS }, "Commands:"),
    "",
    "Run `polyant-cli <command> --help` for a command's usage.",
  ];
  return lines.join("\n");
}

/**
 * Read from the package manifest rather than duplicated in a constant: a second
 * copy is one release away from disagreeing with the one npm installed.
 *
 * `../package.json` resolves the same way from `src/cli.ts` and from
 * `dist/cli.js`, and npm always ships the manifest, so the built and installed
 * paths read the file the version actually came from.
 */
export function renderVersion(): string {
  const manifest = new URL("../package.json", import.meta.url);
  try {
    const { name, version } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
    const label = typeof version === "string" && version.length > 0 ? version : "unknown";
    // The Node version belongs here: it is the first thing a bug report needs and
    // the last thing anyone remembers to include.
    return `${typeof name === "string" ? name : "@polyant-ai/cli"} ${label} (node ${process.version})`;
  } catch {
    // A missing or unreadable manifest must not turn `--version` into a crash.
    return `@polyant-ai/cli unknown (node ${process.version})`;
  }
}

function isCatalogueRequest(argv: readonly string[]): boolean {
  // With no command the output is help, and `--json` makes it machine-readable —
  // the same rule as everywhere else, so `--json` alone counts too. Without this
  // `polyant-cli --json` printed prose to a caller that asked for JSON, which a
  // pipe discovers as a parse error.
  //
  // Root position only: a per-command catalogue would be a second shape to learn.
  const flags = new Set(argv);
  if (argv.length === 1 && flags.has("--json")) return true;
  return argv.length === 2 && flags.has("--json") && (flags.has("--help") || flags.has("-h"));
}

function isVersionRequest(argv: readonly string[]): boolean {
  // Root position only: `agent --version` is not a question about the agent.
  return argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version");
}

/** One node of the machine-readable catalogue. */
interface CommandDescriptor {
  readonly path: string;
  readonly summary: string;
  readonly usage: string;
  readonly supportsDryRun: boolean;
  readonly children?: CommandDescriptor[];
}

function describeCommand(name: string, command: Command, prefix: readonly string[]): CommandDescriptor {
  const path = [...prefix, name];
  const children = Object.keys(command.children ?? {})
    .sort()
    .map((child) => describeCommand(child, (command.children as Record<string, Command>)[child], path));
  return {
    path: path.join(" "),
    summary: command.summary,
    usage: command.usage,
    supportsDryRun: command.supportsDryRun === true,
    ...(children.length === 0 ? {} : { children }),
  };
}

/**
 * The whole command tree as data, for an agent that has to discover the surface
 * rather than guess it. Derived from the same `COMMANDS` the dispatcher uses, so
 * it cannot describe a command that does not exist, or miss one that does.
 *
 * The global flags and exit codes travel with it: they are the contract a caller
 * needs to act on the output, and a catalogue without them would still leave an
 * agent parsing prose.
 */
export function renderCatalogue(): string {
  return `${JSON.stringify(
    {
      name: "polyant-cli",
      version: renderVersion(),
      globalOptions: [
        { flag: "--target", value: "name", summary: "target from polyant.yaml" },
        { flag: "--context", value: "name", summary: "named target/org/workspace shortcut" },
        { flag: "--org", value: "slug", summary: "organisation to act in" },
        { flag: "--workspace", value: "slug", summary: "workspace to act in; sent as x-workspace-slug" },
        { flag: "--json", value: null, summary: "machine-readable output; response bodies pass through unchanged" },
        { flag: "--yes", value: null, summary: "accept a mutation recap without prompting" },
        { flag: "--dry-run", value: null, summary: "print the recap and send nothing" },
      ],
      exitCodes: [
        { code: ExitCode.Ok, meaning: "success" },
        { code: ExitCode.Difference, meaning: "a difference or a failed assertion, not a tool error" },
        { code: ExitCode.Config, meaning: "configuration, usage or authentication; 4xx except 429" },
        { code: ExitCode.Remote, meaning: "remote failure; 5xx, 429, timeout, unreachable. retryable" },
      ],
      commands: Object.keys(COMMANDS)
        .sort()
        .map((name) => describeCommand(name, COMMANDS[name], [])),
    },
    null,
    2,
  )}\n`;
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
    if (isVersionRequest(argv)) {
      process.stdout.write(`${renderVersion()}\n`);
      return ExitCode.Ok;
    }
    if (isCatalogueRequest(argv)) {
      process.stdout.write(renderCatalogue());
      return ExitCode.Ok;
    }
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
