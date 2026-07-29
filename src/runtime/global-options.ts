// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { ConfigError } from "../exit.js";

export interface GlobalOptions {
  target?: string;
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

function consumeGlobalOptions(argv: string[]): { tokens: string[]; global: GlobalOptions } {
  const global = defaults();
  const seen = new Set<GlobalFlag>();
  const tokens: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const { spelling, value: inlineValue } = splitFlag(token);
    const valueKey = VALUE_FLAGS[spelling as keyof typeof VALUE_FLAGS];
    const booleanKey = BOOLEAN_FLAGS[spelling as keyof typeof BOOLEAN_FLAGS];
    if (valueKey === undefined && booleanKey === undefined) {
      tokens.push(token);
      continue;
    }

    const key = valueKey ?? booleanKey;
    if (seen.has(key)) throw new ConfigError(`Duplicate global option ${spelling}.`);
    seen.add(key);

    if (valueKey !== undefined) {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new ConfigError(`Missing value for ${spelling}.`);
      global[valueKey] = value;
      if (inlineValue === undefined) index += 1;
      continue;
    }

    if (inlineValue !== undefined) throw new ConfigError(`${spelling} does not take a value.`);
    global[booleanKey] = true;
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

  const root = commands[rootName];
  if (root === undefined) throw new ConfigError(`Unknown command "${rootName}".`);

  const path = [rootName];
  let command = root;
  let index = 0;
  while (index < rest.length) {
    const child = command.children?.[rest[index]];
    if (child === undefined) break;
    path.push(rest[index]);
    command = child;
    index += 1;
  }

  return { path, args: rest.slice(index), global };
}
