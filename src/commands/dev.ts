// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { spawn as spawnProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Command, CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { renderLabelledResource, writeRawResponse } from "../render/output.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { call, processServiceDependencies, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import { buildNode, type Node } from "../runtime/tree.js";
import { agentPath, preflight } from "../runtime/workspace.js";
import { devConnect } from "./dev-connect.js";
import { devInit } from "./dev-init.js";

/**
 * Dev mode: a developer's local `*.tool.ts` files, served into a REMOTE agent
 * for the duration of a turn. The engine side of it is `dev-mode/` +
 * `server/dev-mode/`; the client runtime is `@polyant-ai/plugin-sdk/dev`. This
 * family is the operator's end: mint the credential, scaffold the project, and
 * hold the socket open.
 *
 * Three deliberate shapes here:
 *
 *  - `token issue` prints the token on STDOUT, because the token is the answer.
 *    It exists in exactly one HTTP response and is never recoverable, so the
 *    warning about that goes on stderr where it cannot corrupt a pipe.
 *  - `token revoke` is destructive in this CLI's sense: it kills whatever is
 *    connected right now, so it names the agent twice.
 *  - `connect` never terminates, the only command here that does not. It also
 *    never touches the token in argv — see `dev-runner.ts`.
 */

/** The filesystem `dev init` writes through, and `dev connect` probes with. */
export interface DevFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, text: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

/** A spawned child, reduced to what `dev connect` needs of it. */
export interface DevChildProcess {
  /** Resolves with the exit code once the child has exited. */
  readonly exited: Promise<number>;
  /** One call per complete line of the child's stdout. */
  onStdoutLine(listener: (line: string) => void): void;
  onStderrLine(listener: (line: string) => void): void;
  /** Asks the child to shut down. Idempotent. */
  stop(): void;
}

export interface DevSpawnOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

export type DevSpawn = (options: DevSpawnOptions) => DevChildProcess;

/**
 * `ServiceDependencies` plus the three things dev mode needs and no other
 * family does: a filesystem, a child process, and the operator's interrupt.
 * Injected for the same reason as the rest — a test replaces all of it at once.
 */
export interface DevCommandDependencies extends ServiceDependencies {
  readonly fs: DevFileSystem;
  readonly spawn: DevSpawn;
  cwd(): string;
  /** Registers an interrupt handler and returns its disposer. */
  onInterrupt(handler: () => void): () => void;
}

/** Splits a byte stream into complete lines, keeping a partial tail buffered. */
function lineReader(listener: (line: string) => void): (chunk: string) => void {
  let buffered = "";
  return (chunk: string) => {
    buffered += chunk;
    let boundary = buffered.indexOf("\n");
    while (boundary !== -1) {
      listener(buffered.slice(0, boundary).replace(/\r$/, ""));
      buffered = buffered.slice(boundary + 1);
      boundary = buffered.indexOf("\n");
    }
  };
}

const processSpawn: DevSpawn = ({ command, args, cwd, env }) => {
  const child = spawnProcess(command, [...args], {
    cwd,
    env: env as NodeJS.ProcessEnv,
    // stdout carries the event lines, stderr the child's diagnostics. Neither is
    // inherited: the CLI owns which of its own streams they end up on.
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return {
    exited: new Promise<number>((resolve) => {
      // A child killed by a signal reports `code === null`; the operator's own
      // interrupt is not a failure, so it resolves as 0 rather than as a crash.
      child.on("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 0)));
      child.on("error", () => resolve(2));
    }),
    onStdoutLine: (listener) => child.stdout.on("data", lineReader(listener)),
    onStderrLine: (listener) => child.stderr.on("data", lineReader(listener)),
    stop: () => {
      try {
        child.kill("SIGINT");
      } catch {
        /* already gone */
      }
    },
  };
};

export const processDevDependencies: DevCommandDependencies = {
  ...processServiceDependencies,
  fs: {
    readFile,
    writeFile,
    mkdir: (path, options) => mkdir(path, options).then(() => undefined),
    exists: (path) => access(path).then(() => true, () => false),
  },
  spawn: processSpawn,
  cwd: () => process.cwd(),
  onInterrupt: (handler) => {
    process.on("SIGINT", handler);
    return () => {
      process.off("SIGINT", handler);
    };
  },
};

/** `requireSlug` names the `agent` family in its message; this one names `dev`. */
export function requireDevSlug(args: readonly string[], action: string): string {
  const slug = args[0];
  if (slug === undefined || slug.startsWith("--")) throw new ConfigError(`polyant-cli dev ${action} needs an agent slug.`);
  return slug;
}

/** The engine's own bound (`DEV_TOKEN_MAX_TTL_HOURS`), restated so a typo fails locally. */
const MAX_TTL_HOURS = 24;

function ttlHours(options: readonly string[]): number | undefined {
  const raw = takeValue(options, "--ttl-hours");
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_TTL_HOURS) {
    throw new ConfigError(`--ttl-hours needs an integer between 1 and ${MAX_TTL_HOURS}.`);
  }
  return Number(raw);
}

interface IssuedToken {
  token?: string;
  expiresAt?: string;
}

async function tokenIssue(args: string[], context: CommandContext | undefined, deps: DevCommandDependencies): Promise<void> {
  const slug = requireDevSlug(args, "token issue");
  const options = args.slice(1);
  assertKnown(options, { value: ["--ttl-hours", "--confirm"] }, "dev token issue option");
  const ttl = ttlHours(options);

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Issue a dev token for ${slug}`,
    changes: [
      `Mint a token valid for ${ttl === undefined ? "the installation's default TTL" : `${ttl} hour(s)`}, stored as a hash.`,
      "Invalidate every dev token previously issued for this agent.",
      "Close the live dev session, if one is connected with an older token.",
      "Print the token once, on stdout: it is not recoverable afterwards.",
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "POST",
    path: agentPath(slug, "/dev-session/token"),
    body: ttl === undefined ? {} : { ttlHours: ttl },
  });
  // The token is the answer, so it goes to stdout on its own line and nothing
  // else does. `--json` passes the engine's body through, token included: a
  // caller that asked for JSON is the caller that will store it.
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);
  const issued = (res.body ?? {}) as IssuedToken;
  if (typeof issued.token !== "string") throw new ConfigError(`POST ${agentPath(slug, "/dev-session/token")} did not return a token.`);
  deps.io.stdout(`${issued.token}\n`);
  deps.io.stderr(
    `Issued for ${slug}, expires ${text(issued.expiresAt)}. Shown once — the engine stores only its hash, so it cannot be read back.\n`,
  );
}

async function tokenRevoke(args: string[], context: CommandContext | undefined, deps: DevCommandDependencies): Promise<void> {
  const slug = requireDevSlug(args, "token revoke");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "dev token revoke option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Revoke every dev token for ${slug}`,
    changes: ["Delete every stored dev token for this agent.", "Close the live dev session, if one is connected."],
    destructive: { confirm: slug },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: agentPath(slug, "/dev-session/token") });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);
  const revoked = (res.body as { revoked?: unknown } | null)?.revoked;
  deps.io.stdout(`Revoked ${text(revoked)} dev token(s) for ${slug}.\n`);
}

export interface DevSessionStatus {
  session: {
    sessionId?: string;
    connectedAt?: string;
    issuedByUserId?: string | null;
    tools?: string[];
    overrides?: string[];
  } | null;
  nodeWarning?: boolean;
}

/**
 * The one-node caveat is reported on EVERY read, not only when something looks
 * wrong: the session lives in memory on a single engine replica, so with more
 * than one the turns served by the others equip none of these tools — and that
 * is invisible from the response.
 */
export function warnAboutNode(deps: DevCommandDependencies, body: DevSessionStatus | null): void {
  if (body?.nodeWarning !== true) return;
  deps.io.stderr(
    "note: a dev session lives in memory on ONE engine node. With more than one replica, turns served by the others equip no dev tools.\n",
  );
}

async function tokenStatus(args: string[], context: CommandContext | undefined, deps: DevCommandDependencies): Promise<void> {
  const slug = requireDevSlug(args, "token status");
  assertKnown(args.slice(1), {}, "dev token status option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: agentPath(slug, "/dev-session") });
  const body = res.body as DevSessionStatus | null;
  if (wantsJson(context)) {
    writeRawResponse(deps.io, res.raw);
    return warnAboutNode(deps, body);
  }

  const session = body?.session ?? null;
  if (session === null) {
    deps.io.stdout(`No dev session is connected to ${slug}.\n`);
  } else {
    deps.io.stdout(
      `${renderLabelledResource([
        { label: "session", value: text(session.sessionId) },
        { label: "connected", value: text(session.connectedAt) },
        { label: "issued by", value: text(session.issuedByUserId) },
        { label: "tools", value: (session.tools ?? []).join(", ") || "-" },
        { label: "overrides", value: (session.overrides ?? []).join(", ") || "-" },
      ])}\n`,
    );
  }
  warnAboutNode(deps, body);
}

const CONNECT_USAGE = `Usage: polyant-cli dev connect <slug> [--dir <path>] [--tools <path>] [--hooks <path>]
                                  [--watch] [--token-env <VAR>] [--token-file <path|->]

Serves the project's local *.tool.ts and *.hook.ts files to a remote agent and
does not return until interrupted. Tools are called by the model, one turn at a
time; hooks run on the turn's lifecycle events.

--tools and --hooks both default to the project directory: each loader matches
its own filename suffix, so one tree holding both needs neither option. A hook
file says how it enters the pipeline with a \`dev\` export beside its definition:
\`devHook({ overrides })\` to run in place of one the agent already has,
\`devHook({ bindTo })\` to run on an event for the length of the session.

The token comes from the environment ($POLYANT_DEV_TOKEN unless --token-env
names another variable) or from a file; there is no --token flag, because argv
is visible in \`ps\`. Issue one with \`polyant-cli dev token issue <slug>\`.

The project must carry \`tsx\` and \`@polyant-ai/plugin-sdk\` in its own
node_modules: a *.tool.ts file is imported by a child process started in that
directory, which is the only place it resolves from. \`dev init\` writes both.
Hooks need SDK 1.8 or newer; an older one serves tools and no hooks.

With --json, one JSON object per line on stdout, streamable. Without it, the
tool calls are on stdout and everything else on stderr.

Exit codes: 2 for a wrong token, agent or project; 3 for an engine that could
not be reached; 0 when you interrupt it.`;

/**
 * The tree, built per dependency set: a leaf action closes over
 * `DevCommandDependencies`, which the shared `Action` signature (deliberately
 * `ServiceDependencies`) cannot carry.
 */
function leaves(deps: DevCommandDependencies): Record<string, Node> {
  return {
    token: {
      issue: {
        summary: "mint a dev token for an agent, shown once",
        usage: `Usage: polyant-cli dev token issue <slug> [--ttl-hours <1-${MAX_TTL_HOURS}>] --yes

The token is printed on stdout and exists in that one response only — the engine
stores a hash. Issuing invalidates every previous token for the agent and closes
a session connected with one. Without --ttl-hours the engine applies the
installation policy a platform admin sets (engine 1.2.0), not an environment
variable. A token issued through a personal token ends when that token is
revoked.`,
        action: (args, context) => tokenIssue(args, context, deps),
        mutates: true,
      },
      revoke: {
        summary: "revoke every dev token for an agent and close its session",
        usage: "Usage: polyant-cli dev token revoke <slug> --yes --confirm <slug>",
        action: (args, context) => tokenRevoke(args, context, deps),
        mutates: true,
      },
      status: {
        summary: "report the dev session connected to an agent, if any",
        usage: `Usage: polyant-cli dev token status <slug>

Names the tools the session serves and which of them shadow a built-in one by
name collision. Always reports the single-node caveat on stderr.`,
        action: (args, context) => tokenStatus(args, context, deps),
      },
    },
    init: {
      summary: "scaffold a local tool project for dev mode",
      usage: `Usage: polyant-cli dev init [<dir>] [--agent <slug>] [--force]

Writes package.json, tsconfig.json, .gitignore and one example tool. Refuses to
replace an existing file unless --force says so.`,
      action: (args, context) => devInit(args, context, deps),
      mutates: true,
    },
    connect: {
      summary: "serve local tools to a remote agent until interrupted",
      usage: CONNECT_USAGE,
      action: (args, context) => devConnect(args, context, deps),
    },
  };
}

const DEV_SUMMARIES: Record<string, string> = {
  dev: "run local tools against a remote agent",
  "dev token": "manage the credential a dev session authenticates with",
};

export function createDevCommand(overrides: Partial<DevCommandDependencies> = {}): Command {
  const deps: DevCommandDependencies = { ...processDevDependencies, ...overrides };
  return buildNode(leaves(deps), deps, ["dev"], DEV_SUMMARIES);
}

export const devCommand = createDevCommand();
