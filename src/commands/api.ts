// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ConfigError } from "../exit.js";
import { loadWorkspaceConfig, type ResolvedTarget } from "../config.js";
import { request } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import { resolveScope } from "../runtime/scope.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import { confirmMutation, type ConfirmationIO } from "../runtime/confirm.js";
import { processConfirmationIO } from "../runtime/process-io.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const API_USAGE = `Usage: polyant-cli api <METHOD> <path> [options]

Raw passthrough to the management API: resolves the base URL and the auth
header, forwards the request, prints the response body on stdout unchanged.

Every non-GET request is recapped on stderr and confirmed before it leaves.
The recap names the target, the method, the path and where the body came from;
it never prints the body, and never parses it.

Options:
  --data <@file|->   JSON request body — @path reads a file, - reads stdin
  --query <k=v>      query parameter, repeatable
  --confirm <path>   required for DELETE: repeat the path being deleted
  --target <name>    target from polyant.yaml (default: its "default")
  --url <baseUrl>    override the target's baseUrl

Paths start with "/". Not every route is under /api — /health, /v1, /memories,
/channels/http, /webhooks and /oauth are top level.

Methods: ${METHODS.join(", ")}`;

export interface ApiArgs {
  method: string;
  path: string;
  confirm?: string;
  data?: string;
  query: Record<string, string>;
  target?: string;
  url?: string;
}

function splitQuery(pairs: string[]): Record<string, string> {
  const query: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new ConfigError(`--query expects k=v (got "${pair}").`);
    query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return query;
}

/**
 * The return type is inferred on purpose: `parseArgs` already types `values`
 * from the options table, so annotating it here would only add casts.
 */
function parseApiFlags(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        confirm: { type: "string" },
        data: { type: "string" },
        query: { type: "string", multiple: true },
        target: { type: "string" },
        url: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    // ERR_PARSE_ARGS_* is the caller's mistake, so it must exit 2 rather than
    // escape as an internal error.
    throw new ConfigError(`${error instanceof Error ? error.message : String(error)}\n\n${API_USAGE}`);
  }
}

function requireMethodAndPath(positionals: string[]): { method: string; path: string } {
  const [rawMethod, path] = positionals;
  if (rawMethod === undefined) throw new ConfigError(`Missing METHOD.\n\n${API_USAGE}`);
  if (path === undefined) throw new ConfigError(`Missing path.\n\n${API_USAGE}`);

  const method = rawMethod.toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) {
    throw new ConfigError(`Unsupported method "${rawMethod}". Use one of: ${METHODS.join(", ")}.`);
  }
  return { method, path };
}

export function parseApiArgs(argv: string[]): ApiArgs {
  const { values, positionals } = parseApiFlags(argv);
  return {
    ...requireMethodAndPath(positionals),
    ...(values.confirm === undefined ? {} : { confirm: values.confirm }),
    ...(values.data === undefined ? {} : { data: values.data }),
    query: splitQuery(values.query ?? []),
    ...(values.target === undefined ? {} : { target: values.target }),
    ...(values.url === undefined ? {} : { url: values.url }),
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface RawPayload {
  /** The caller's own bytes, forwarded unchanged. */
  readonly text: string;
  /** Where it came from, for the recap. Never the content. */
  readonly source: string;
}

async function readData(spec: string): Promise<RawPayload> {
  let text: string;
  let source: string;
  if (spec === "-") {
    text = await readStdin();
    source = "stdin";
  } else if (spec.startsWith("@")) {
    const file = spec.slice(1);
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new ConfigError(`--data cannot read "${file}".`);
    }
    source = file;
  } else {
    throw new ConfigError(`--data expects "@<file>" or "-" (got "${spec}").`);
  }

  // Parsed only to reject a malformed payload locally instead of as a remote
  // 400 — the parsed value is then discarded. What travels is `text`, so the
  // caller's integer precision, `1.0` spelling and key order survive intact.
  try {
    JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`--data is not valid JSON — ${reason}`);
  }
  return { text, source };
}

/**
 * `--url` is a global flag, so the runtime's parser consumes it before this
 * command's own parser sees it. The local spelling survives for a direct caller
 * that hands `run` its argv without going through `parseInvocation`.
 */
function urlForScope(context: CommandContext | undefined, url: string | undefined): string | undefined {
  return url ?? context?.global.url;
}

/** Lets direct command callers retain local --target parsing while the runtime owns global flags. */
function globalForScope(context: CommandContext | undefined, target: string | undefined): GlobalOptions {
  const global = context?.global;
  if (global === undefined) return { json: false, yes: false, dryRun: false, ...(target === undefined ? {} : { target }) };
  return global.target === undefined && target !== undefined ? { ...global, target } : global;
}

async function resolveInvocation(args: ApiArgs, context?: CommandContext): Promise<{ target: ResolvedTarget; payload?: RawPayload }> {
  const config = await loadWorkspaceConfig();
  const url = urlForScope(context, args.url);
  const target = resolveScope({
    config,
    env: process.env,
    global: globalForScope(context, args.target),
    ...(url === undefined ? {} : { url }),
    required: ["target"],
  }).target;
  const payload = args.data === undefined ? undefined : await readData(args.data);
  return { target, ...(payload === undefined ? {} : { payload }) };
}

/**
 * A raw non-GET request goes through the same preflight as every other mutation:
 * a recap on stderr, then a confirmation. The recap describes the payload's
 * *source*, never its content — printing a body would put a secret on the
 * terminal, and parsing one to summarise it would defeat the passthrough this
 * command exists to be.
 *
 * DELETE additionally requires `--confirm <path>`: an unrecoverable raw call is
 * the one case where naming the target twice is worth the keystrokes.
 */
async function preflight(
  args: ApiArgs,
  target: ResolvedTarget,
  payload: RawPayload | undefined,
  context: CommandContext | undefined,
  io: ConfirmationIO,
): Promise<boolean> {
  if (args.method === "GET") return true;

  const changes = [
    `Send ${args.method} to ${target.baseUrl}${args.path}.`,
    payload === undefined
      ? "No request body."
      : `Request body: ${payload.source} (${Buffer.byteLength(payload.text, "utf8")} bytes, forwarded unchanged).`,
    ...(Object.keys(args.query).length === 0 ? [] : [`Query parameters: ${Object.keys(args.query).sort().join(", ")}.`]),
  ];

  const decision = await confirmMutation(
    {
      title: `${args.method} ${args.path}`,
      scope: { target: target.name, prod: target.prod },
      changes,
      ...(args.method === "DELETE" ? { destructive: { confirm: args.path } } : {}),
    },
    {
      yes: context?.global.yes ?? false,
      dryRun: context?.global.dryRun ?? false,
      ...(args.confirm === undefined ? {} : { confirm: args.confirm }),
    },
    io,
  );
  return decision.shouldWrite;
}

async function run(argv: string[], context?: CommandContext): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${API_USAGE}\n`);
    return;
  }

  const args = parseApiArgs(argv);
  const { target, payload } = await resolveInvocation(args, context);
  if (!(await preflight(args, target, payload, context, processConfirmationIO))) return;

  const res = await request(target, {
    method: args.method,
    path: args.path,
    query: args.query,
    ...(payload === undefined ? {} : { rawBody: payload.text }),
  });

  // The response text verbatim. Parsing and re-serialising would silently alter
  // it — a large integer loses precision, `1.0` becomes `1`, duplicate keys
  // collapse — and contract §7.5 requires no transformation of the JSON. An
  // empty body (a 204) prints nothing rather than a fabricated `null`.
  if (res.raw.length > 0) process.stdout.write(`${res.raw}\n`);
}

export const apiCommand = {
  summary: "raw passthrough to the management API",
  usage: API_USAGE,
  supportsDryRun: true,
  run,
} satisfies Command;
