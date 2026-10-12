// SPDX-License-Identifier: Apache-2.0
import type { Command, CommandContext } from "../command.js";
import type { ServiceDependencies } from "./service.js";

/**
 * The shape every command family declares itself in, and the one builder that
 * turns it into `Command` nodes.
 *
 * `agent` and the administration families each grew their own copy of this —
 * identical `Leaf`, identical `toCommand`, identical `isLeaf` — and the copies
 * had already started to differ in how deep they let a family nest. One builder,
 * so a family cannot acquire a dry-run rule or a depth the others lack.
 */
export type Action = (args: string[], context: CommandContext | undefined, deps: ServiceDependencies) => Promise<void>;

export interface Leaf {
  readonly summary: string;
  readonly usage: string;
  readonly action: Action;
  /** Marks a command that writes: it owns the recap, the confirmation and `--dry-run`. */
  readonly mutates?: boolean;
}

/** A family is a leaf, or a group of nodes — nested to whatever depth it needs. */
export type Node = Leaf | { readonly [name: string]: Node };

export function isLeaf(node: Node): node is Leaf {
  return "action" in node && typeof (node as Leaf).action === "function";
}

/**
 * A group's one-line summary, looked up by its space-joined path
 * (`"agent skills"`). A group with no entry falls back to its usage line alone,
 * which is worse than a sentence but never wrong.
 */
export type Summaries = Readonly<Record<string, string>>;

export function buildNode(
  node: Node,
  deps: ServiceDependencies,
  path: readonly string[],
  summaries: Summaries = {},
): Command {
  if (isLeaf(node)) {
    return {
      summary: node.summary,
      usage: node.usage,
      ...(node.mutates === true ? { supportsDryRun: true } : {}),
      run: (args, context) => node.action(args, context, deps),
    };
  }

  const children: Record<string, Command> = {};
  for (const [name, child] of Object.entries(node)) {
    children[name] = buildNode(child, deps, [...path, name], summaries);
  }
  const key = path.join(" ");
  return {
    summary: summaries[key] ?? `manage ${key}`,
    usage: `Usage: polyant-cli ${key} <action> [options]`,
    children,
  };
}
