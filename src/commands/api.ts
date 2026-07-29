// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ConfigError } from "../exit.js";
import { loadWorkspaceConfig, resolveTarget, type ResolvedTarget } from "../config.js";
import { request } from "../api/client.js";
import type { Command } from "../command.js";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const API_USAGE = `Usage: polyant api <METHOD> <path> [options]

Raw passthrough to the management API: resolves the base URL and the auth
header, forwards the request, prints the response body on stdout unchanged.

Options:
  --data <@file|->   JSON request body — @path reads a file, - reads stdin
  --query <k=v>      query parameter, repeatable
  --target <name>    target from polyant.yaml (default: its "default")
  --url <baseUrl>    override the target's baseUrl

Paths start with "/". Not every route is under /api — /health, /v1, /memories,
/channels/http, /webhooks and /oauth are top level.

Methods: ${METHODS.join(", ")}`;

export interface ApiArgs {
  method: string;
  path: string;
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

async function readData(spec: string): Promise<unknown> {
  let text: string;
  if (spec === "-") {
    text = await readStdin();
  } else if (spec.startsWith("@")) {
    const file = spec.slice(1);
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new ConfigError(`--data cannot read "${file}".`);
    }
  } else {
    throw new ConfigError(`--data expects "@<file>" or "-" (got "${spec}").`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`--data is not valid JSON — ${reason}`);
  }
}

async function resolveInvocation(args: ApiArgs): Promise<{ target: ResolvedTarget; body: unknown }> {
  const config = await loadWorkspaceConfig();
  const target = resolveTarget({
    config,
    env: process.env,
    ...(args.target === undefined ? {} : { target: args.target }),
    ...(args.url === undefined ? {} : { url: args.url }),
  });
  const body = args.data === undefined ? undefined : await readData(args.data);
  return { target, body };
}

/**
 * Every mutation announces its target on stderr before it leaves, so the
 * operator can see which environment was written to. This is the command's only
 * safety measure — `--yes` and `--dry-run` belong to `push`, not here.
 */
function announce(method: string, target: ResolvedTarget, path: string): void {
  if (method === "GET") return;
  const label = target.prod ? `${target.name}, PROD` : target.name;
  process.stderr.write(`→ ${method} ${target.baseUrl}${path} [${label}]\n`);
}

async function run(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${API_USAGE}\n`);
    return;
  }

  const args = parseApiArgs(argv);
  const { target, body } = await resolveInvocation(args);
  announce(args.method, target, args.path);

  const res = await request(target, {
    method: args.method,
    path: args.path,
    query: args.query,
    ...(body === undefined ? {} : { body }),
  });

  // The response text verbatim. Parsing and re-serialising would silently alter
  // it — a large integer loses precision, `1.0` becomes `1`, duplicate keys
  // collapse — and contract §7.5 requires no transformation of the JSON. An
  // empty body (a 204) prints nothing rather than a fabricated `null`.
  if (res.raw.length > 0) process.stdout.write(`${res.raw}\n`);
}

export const apiCommand: Command = {
  summary: "raw passthrough to the management API",
  usage: API_USAGE,
  run,
};
