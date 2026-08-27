// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import {
  call,
  expectArray,
  maybe,
  positiveInteger,
  scopeFor,
  text,
  wantsJson,
  type ServiceDependencies,
} from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";
import { agentPath, preflight, reportWrite, requireSecond, requireSlug } from "../runtime/workspace.js";

/**
 * What an agent remembers, and who has told it to stop.
 *
 * Both are per-agent operational data that the panel exposes and the CLI did
 * not, and both are places where a wrong command is felt by a person rather
 * than by a service: a cleared memory cannot be reconstructed, and opting a
 * contact back IN resumes messaging someone who asked to be left alone. Every
 * write here therefore names its subject twice.
 */

interface MemoryRow {
  id: string;
  content: string;
  category: string | null;
  importance: number | null;
  createdAt: string | null;
}

/**
 * `/memories` is one of the routes that does not sit under `/api`, and it takes
 * the agent as a query parameter rather than as a path segment. Despite the
 * name, `instanceId` carries the agent's SLUG — the engine resolves it as one.
 */
const MEMORIES_PATH = "/memories";

function memoryQuery(slug: string, rest: Record<string, string> = {}): Record<string, string> {
  return { instanceId: slug, ...rest };
}

async function memoryList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "memory list");
  const options = args.slice(1);
  assertKnown(options, { value: ["--search", "--category", "--limit", "--offset"] }, "agent memory list option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    path: MEMORIES_PATH,
    query: memoryQuery(slug, {
      ...maybe("search", takeValue(options, "--search")),
      ...maybe("category", takeValue(options, "--category")),
      ...maybe("limit", positiveInteger(takeValue(options, "--limit"), "--limit")),
      ...maybe("offset", positiveInteger(takeValue(options, "--offset"), "--offset")),
    }),
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const memories = expectArray<MemoryRow>((res.body as { memories?: unknown } | null)?.memories, `GET ${MEMORIES_PATH}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "CATEGORY", "IMPORTANCE", "CREATED", "CONTENT"],
      rows: memories.map((memory) => [
        text(memory.id),
        text(memory.category),
        text(memory.importance),
        text(memory.createdAt),
        text(memory.content),
      ]),
      emptyMessage: `Agent ${slug} has remembered nothing matching that.`,
    })}\n`,
  );
}

/**
 * The content arrives as a payload, not as a flag: a memory is free text that
 * can be long, can be multi-line, and can be about a person — three reasons not
 * to leave it in shell history and `ps` output.
 */
async function memoryAdd(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "memory add");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--category", "--importance", "--confirm"] }, "agent memory add option");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError("polyant-cli agent memory add needs --file <path> (or --file - for stdin).");
  const content = (await deps.readPayload(file)).trim();
  if (content.length === 0) throw new ConfigError(`${file === "-" ? "The stdin payload" : file} is empty; a memory needs content.`);
  const category = takeValue(options, "--category");
  const importance = takeValue(options, "--importance");
  if (importance !== undefined && !/^([1-9]|10)$/.test(importance)) {
    throw new ConfigError("--importance needs an integer between 1 and 10.");
  }

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Write a memory for ${slug}`,
    changes: [
      // Length and source, never the content: the recap goes to stderr, which
      // is where a terminal transcript and a CI log both end up.
      `${content.length} characters from ${file === "-" ? "stdin" : file}.`,
      `Category ${category ?? "general"}, importance ${importance ?? "5"}.`,
      "The engine embeds it, so the agent's embedding provider must be configured.",
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "POST",
    path: MEMORIES_PATH,
    body: {
      instanceId: slug,
      content,
      ...(category === undefined ? {} : { category }),
      ...(importance === undefined ? {} : { importance: Number(importance) }),
    },
  });
  reportWrite(deps, context, res, `Wrote a memory for ${slug}.`);
}

async function memoryRemove(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "memory remove");
  const id = requireSecond(args, "memory remove", "memory id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent memory remove option");
  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Delete memory ${id} from ${slug}`,
    changes: ["The memory and its embedding are removed. The engine keeps no archive."],
    destructive: { confirm: id },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "DELETE",
    path: `${MEMORIES_PATH}/${encodeURIComponent(id)}`,
    query: memoryQuery(slug),
  });
  reportWrite(deps, context, res, `Deleted memory ${id} from ${slug}.`);
}

async function memoryClear(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "memory clear");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "agent memory clear option");
  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Clear every memory of ${slug}`,
    changes: ["Every stored memory and embedding for this agent is deleted.", "There is no archive and no undo."],
    destructive: { confirm: slug },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: MEMORIES_PATH, query: memoryQuery(slug) });
  reportWrite(deps, context, res, `Cleared every memory of ${slug}.`);
}

// --- optouts -----------------------------------------------------------------

const OPTOUT_STATUSES = ["opted_out", "opted_in", "all"] as const;

interface OptoutRow {
  channelType: string;
  channelId: string;
  status: string;
  source: string | null;
  updatedAt: string | null;
}

function optoutsPath(slug: string, rest = ""): string {
  return agentPath(slug, `/optouts${rest}`);
}

/** A contact is a channel type plus an address on it; both are always needed. */
function requireContact(options: readonly string[], action: string): { channelType: string; channelId: string } {
  const channelType = takeValue(options, "--channel");
  const channelId = takeValue(options, "--contact");
  if (channelType === undefined) throw new ConfigError(`polyant-cli agent optouts ${action} needs --channel <type>.`);
  if (channelId === undefined) throw new ConfigError(`polyant-cli agent optouts ${action} needs --contact <id>.`);
  return { channelType, channelId };
}

async function optoutsList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "optouts list");
  const options = args.slice(1);
  assertKnown(options, { value: ["--status", "--page"] }, "agent optouts list option");
  const status = takeValue(options, "--status");
  if (status !== undefined && !(OPTOUT_STATUSES as readonly string[]).includes(status)) {
    throw new ConfigError(`--status must be one of ${OPTOUT_STATUSES.join(", ")}.`);
  }
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    path: optoutsPath(slug),
    query: { ...maybe("status", status), ...maybe("page", positiveInteger(takeValue(options, "--page"), "--page")) },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const optouts = expectArray<OptoutRow>((res.body as { optouts?: unknown } | null)?.optouts, `GET ${optoutsPath(slug)}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["CHANNEL", "CONTACT", "STATUS", "SOURCE", "UPDATED"],
      rows: optouts.map((optout) => [
        text(optout.channelType),
        text(optout.channelId),
        text(optout.status),
        text(optout.source),
        text(optout.updatedAt),
      ]),
      // The default filter is "currently opted out", so an empty list is the
      // good news it sounds like — say which question was actually asked.
      emptyMessage: `No contact of ${slug} matches that status.`,
    })}\n`,
  );
}

async function optoutsOptOut(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "optouts opt-out");
  const options = args.slice(1);
  assertKnown(options, { value: ["--channel", "--contact", "--confirm"] }, "agent optouts opt-out option");
  const contact = requireContact(options, "opt-out");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Opt ${contact.channelId} out of ${slug}`,
    changes: [`The agent stops messaging ${contact.channelId} on ${contact.channelType}.`, "Recorded with source \"admin\"."],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: optoutsPath(slug), body: contact });
  reportWrite(deps, context, res, `Opted ${contact.channelId} out of ${slug}.`);
}

async function optoutsOptIn(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "optouts opt-in");
  const options = args.slice(1);
  assertKnown(options, { value: ["--channel", "--contact", "--confirm"] }, "agent optouts opt-in option");
  const contact = requireContact(options, "opt-in");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Opt ${contact.channelId} back in to ${slug}`,
    changes: [
      `The agent may message ${contact.channelId} on ${contact.channelType} again.`,
      "That contact asked to stop: do this only on their own request.",
    ],
    destructive: { confirm: contact.channelId },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "DELETE",
    path: optoutsPath(slug, `/${encodeURIComponent(contact.channelType)}/${encodeURIComponent(contact.channelId)}`),
  });
  reportWrite(deps, context, res, `Opted ${contact.channelId} back in to ${slug}.`);
}

export const AGENT_DATA_EXTRAS: Record<string, Node> = {
  memory: {
    list: {
      summary: "list what an agent has remembered",
      usage: "Usage: polyant-cli agent memory list <slug> [--search <text>] [--category <c>] [--limit <n>] [--offset <n>]",
      action: memoryList,
    },
    add: {
      summary: "write one memory from a file or stdin",
      usage: `Usage: polyant-cli agent memory add <slug> --file <path|-> [--category <c>] [--importance <1-10>]

The content comes from a file or stdin, never a flag. The engine embeds it on
write, so the agent needs a working embedding provider or the write is a 400.`,
      action: memoryAdd,
      mutates: true,
    },
    remove: {
      summary: "delete one memory and its embedding",
      usage: "Usage: polyant-cli agent memory remove <slug> <memoryId> --yes --confirm <memoryId>",
      action: memoryRemove,
      mutates: true,
    },
    clear: {
      summary: "delete every memory this agent holds",
      usage: "Usage: polyant-cli agent memory clear <slug> --yes --confirm <slug>\n\nPermanent: the engine keeps no archive.",
      action: memoryClear,
      mutates: true,
    },
  },
  optouts: {
    list: {
      summary: "list the contacts that have opted out of this agent",
      usage: `Usage: polyant-cli agent optouts list <slug> [--status opted_out|opted_in|all] [--page <n>]

Defaults to the contacts currently opted OUT. Pages are fixed at 50 rows.`,
      action: optoutsList,
    },
    "opt-out": {
      summary: "opt one contact out on their behalf",
      usage: "Usage: polyant-cli agent optouts opt-out <slug> --channel <type> --contact <id> --yes",
      action: optoutsOptOut,
      mutates: true,
    },
    "opt-in": {
      summary: "opt one contact back in",
      usage: `Usage: polyant-cli agent optouts opt-in <slug> --channel <type> --contact <id> --yes --confirm <id>

Resumes messaging someone who asked to stop, which is why the contact is named
twice. Do it on their own request, not to clear a list.`,
      action: optoutsOptIn,
      mutates: true,
    },
  },
};
