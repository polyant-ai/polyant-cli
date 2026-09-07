// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { ConfigError } from "../exit.js";

export interface GlobalOptions {
  target?: string;
  /**
   * Per-invocation base URL, overriding the resolved target's. It exists as a
   * global rather than a per-command flag because retargeting is orthogonal to
   * what the command does: every scoped command resolves its target the same
   * way, so the override has to be available to all of them.
   */
  url?: string;
  org?: string;
  workspace?: string;
  context?: string;
  json: boolean;
  yes: boolean;
  dryRun: boolean;
}

export interface Invocation {
  path: string[];
  args: string[];
  global: GlobalOptions;
}

/** A command node used for path resolution without importing the CLI command implementation. */
export interface CommandNode {
  readonly children?: CommandTree;
}

export type CommandTree = Record<string, CommandNode>;

const VALUE_FLAGS = {
  "--target": "target",
  "--url": "url",
  "--org": "org",
  "--workspace": "workspace",
  "--context": "context",
} as const;

const BOOLEAN_FLAGS = {
  "--json": "json",
  "--yes": "yes",
  "--dry-run": "dryRun",
} as const;

type ValueFlag = (typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS];
type BooleanFlag = (typeof BOOLEAN_FLAGS)[keyof typeof BOOLEAN_FLAGS];
type GlobalFlag = ValueFlag | BooleanFlag;

function defaults(): GlobalOptions {
  return { json: false, yes: false, dryRun: false };
}

function splitFlag(token: string): { spelling: string; value?: string } {
  const equals = token.indexOf("=");
  return equals === -1 ? { spelling: token } : { spelling: token.slice(0, equals), value: token.slice(equals + 1) };
}

function valueFlag(spelling: string): ValueFlag | undefined {
  return Object.hasOwn(VALUE_FLAGS, spelling) ? VALUE_FLAGS[spelling as keyof typeof VALUE_FLAGS] : undefined;
}

function booleanFlag(spelling: string): BooleanFlag | undefined {
  return Object.hasOwn(BOOLEAN_FLAGS, spelling) ? BOOLEAN_FLAGS[spelling as keyof typeof BOOLEAN_FLAGS] : undefined;
}

function childCommand(command: CommandNode, name: string): CommandNode | undefined {
  const children = command.children;
  return children !== undefined && Object.hasOwn(children, name) ? children[name] : undefined;
}

function consumeGlobalOptions(argv: string[]): { tokens: string[]; global: GlobalOptions } {
  const global = defaults();
  const seen = new Set<GlobalFlag>();
  const tokens: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      tokens.push(...argv.slice(index));
      break;
    }
    const { spelling, value: inlineValue } = splitFlag(token);
    const valueKey = valueFlag(spelling);
    const booleanKey = booleanFlag(spelling);
    if (valueKey !== undefined) {
      if (seen.has(valueKey)) throw new ConfigError(`Duplicate global option ${spelling}.`);
      seen.add(valueKey);
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        throw new ConfigError(`Missing value for ${spelling}.`);
      }
      global[valueKey] = value;
      if (inlineValue === undefined) index += 1;
      continue;
    }

    if (booleanKey !== undefined) {
      if (seen.has(booleanKey)) throw new ConfigError(`Duplicate global option ${spelling}.`);
      seen.add(booleanKey);
      if (inlineValue !== undefined) throw new ConfigError(`${spelling} does not take a value.`);
      global[booleanKey] = true;
      continue;
    }

    tokens.push(token);
  }

  return { tokens, global };
}

/**
 * Separates process-wide flags from command routing. Unknown flags after a
 * command are deliberately preserved for that command's own parser; only an
 * unknown option in root position is a malformed global invocation.
 */
export function parseInvocation(argv: string[], commands: CommandTree): Invocation {
  const { tokens, global } = consumeGlobalOptions(argv);
  const [rootName, ...rest] = tokens;

  if (rootName === undefined || rootName === "--help" || rootName === "-h" || rootName === "help") {
    return { path: [], args: rootName === undefined ? [] : [rootName, ...rest], global };
  }
  if (rootName.startsWith("--")) throw new ConfigError(`Unknown global option "${rootName}".`);

  const root = Object.hasOwn(commands, rootName) ? commands[rootName] : undefined;
  if (root === undefined) throw new ConfigError(`Unknown command "${rootName}".`);

  const path = [rootName];
  let command = root;
  let index = 0;
  while (index < rest.length) {
    const child = childCommand(command, rest[index]);
    if (child === undefined) break;
    path.push(rest[index]);
    command = child;
    index += 1;
  }

  return { path, args: rest.slice(index), global };
}
