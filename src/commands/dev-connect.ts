// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { isAbsolute, join, resolve } from "node:path";
import type { CommandContext } from "../command.js";
import { CliError, ConfigError, ExitCode, type ExitCodeValue } from "../exit.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { call, scopeFor, wantsJson } from "../runtime/service.js";
import { DEV_EVENT_MARKER, DEV_RUNNER_ENV, DEV_RUNNER_SOURCE } from "./dev-runner.js";
import { requireDevSlug, warnAboutNode, type DevCommandDependencies, type DevSessionStatus } from "./dev.js";
import { agentPath } from "../runtime/workspace.js";

/**
 * `dev connect` — the one command in this CLI that does not terminate.
 *
 * It owns three things and delegates everything else. It owns the CREDENTIAL
 * (from the environment or a file, never argv), the PROJECT check (a missing
 * `tsx` or SDK is a wrong project, reported as such rather than as a crash from
 * a child process), and the OUTPUT contract. The session itself belongs to
 * `@polyant-ai/plugin-sdk/dev`, running in a child process because only a
 * process started with `tsx` can import the operator's `*.tool.ts` files — see
 * the header of `dev-runner.ts` for why that child is started the way it is.
 *
 * Exit codes are the contract a caller branches on: 2 for a wrong token, agent
 * or project, 3 for an engine that could not be reached, 0 for an interrupt.
 * The runner reports its own, so nothing here has to guess one from a message.
 */

const DEFAULT_TOKEN_ENV = "POLYANT_DEV_TOKEN";

interface SessionEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

function resolveToken(options: readonly string[], deps: DevCommandDependencies, slug: string): Promise<string> {
  const file = takeValue(options, "--token-file");
  const variable = takeValue(options, "--token-env") ?? DEFAULT_TOKEN_ENV;
  if (file !== undefined && options.includes("--token-env")) {
    throw new ConfigError("Use only one of --token-file or --token-env.");
  }
  if (file !== undefined) return readTokenFile(deps, file);

  const fromEnv = deps.env[variable];
  if (fromEnv === undefined || fromEnv.trim().length === 0) {
    throw new ConfigError(
      `$${variable} is unset or empty. Issue a token with \`polyant-cli dev token issue ${slug}\` and export it, ` +
        "or pass --token-file <path|->. There is no --token flag: argv is visible in `ps`.",
    );
  }
  return Promise.resolve(fromEnv.trim());
}

async function readTokenFile(deps: DevCommandDependencies, file: string): Promise<string> {
  const token = (await deps.readPayload(file)).trim();
  if (token.length === 0) throw new ConfigError(`${file === "-" ? "The stdin payload" : file} carried no token.`);
  return token;
}

/**
 * The project must resolve BOTH by itself. Letting the child fail instead would
 * report Node's "unknown file extension" or a bare ERR_MODULE_NOT_FOUND, which
 * says nothing about what to install or where.
 */
async function requireProject(deps: DevCommandDependencies, directory: string): Promise<string> {
  const tsx = join(directory, "node_modules", ".bin", "tsx");
  if (!(await deps.fs.exists(tsx))) {
    throw new ConfigError(
      `${directory} has no node_modules/.bin/tsx. A *.tool.ts file can only be imported by a process started with ` +
        "tsx, so it must be installed in the project itself: run `npm install` there, or `polyant-cli dev init` first.",
    );
  }
  if (!(await deps.fs.exists(join(directory, "node_modules", "@polyant-ai", "plugin-sdk", "package.json")))) {
    throw new ConfigError(
      `${directory} has no node_modules/@polyant-ai/plugin-sdk. A tool file's \`import "@polyant-ai/plugin-sdk"\` ` +
        "resolves from the project, not from the CLI, so it must be a dependency there.",
    );
  }
  return tsx;
}

function toolPaths(options: readonly string[], directory: string): string[] {
  return pathsFor(options, "--tools", directory);
}

/** The search root for one kind of file: the given path, or the project itself.
 *  Tools and hooks default to the SAME directory — each loader matches its own
 *  filename suffix, so one tree holding both needs no option at all. */
function pathsFor(options: readonly string[], flag: string, directory: string): string[] {
  const given = takeValue(options, flag);
  if (given === undefined) return [directory];
  return [isAbsolute(given) ? given : resolve(directory, given)];
}

/**
 * Human rendering. The tool calls go to stdout — they are the log the operator
 * came for — and the session's own lifecycle to stderr, so `| tee` keeps the
 * calls alone.
 */
function renderEvent(deps: DevCommandDependencies, event: SessionEvent): void {
  const say = (line: string) => deps.io.stderr(`${line}\n`);
  switch (event.type) {
    case "connecting":
      return say(`connecting to ${String(event.url)} (attempt ${String(event.attempt)})`);
    case "connected": {
      const tools = (event.tools as string[] | undefined) ?? [];
      say(`connected: session ${String(event.sessionId)}, engine ${String(event.engineVersion)}, serving ${tools.length} tool(s): ${tools.join(", ") || "-"}`);
      for (const warning of (event.warnings as string[] | undefined) ?? []) say(`warning: ${warning}`);
      return;
    }
    case "handshake_rejected":
      return say(`refused by the engine: ${String(event.reason)}`);
    case "invoke":
      return deps.io.stdout(`→ ${String(event.tool)} (${String(event.callId)})\n`);
    case "result":
      return deps.io.stdout(
        `← ${String(event.tool)} ${event.ok === true ? "ok" : `error: ${String(event.error ?? "unknown")}`} ${String(event.durationMs)}ms\n`,
      );
    case "aborted":
      return deps.io.stdout(`← ${String(event.tool)} aborted by the engine\n`);
    case "ctx_request":
      return say(`ctx.${String(event.op)} for call ${String(event.callId)}`);
    case "tools_updated":
      return say(`tools reloaded: ${((event.tools as string[] | undefined) ?? []).join(", ") || "-"}`);
    case "hooks_updated":
      return say(`hooks reloaded: ${((event.hooks as string[] | undefined) ?? []).join(", ") || "-"}`);
    case "hooks_update_rejected":
      return say(`hook reload refused by the engine, keeping the previous hooks: ${String(event.reason)}`);
    // A hook call goes to stdout beside the tool calls — it is the log the
    // operator came for — with the event named, since a hook is invoked by the
    // turn's lifecycle and not by the model.
    case "hook_invoke":
      return deps.io.stdout(`→ ${String(event.hook)} on ${String(event.event)} (${String(event.callId)})\n`);
    case "hook_result":
      return deps.io.stdout(
        `← ${String(event.hook)} ${event.ok === true ? "ok" : `error: ${String(event.error ?? "unknown")}`} ${String(event.durationMs)}ms\n`,
      );
    case "reload_failed":
      return say(`reload failed, keeping the previous tools: ${String(event.message)}`);
    case "watching":
      return say(`watching ${((event.paths as string[] | undefined) ?? []).join(", ")} for changes`);
    case "disconnected":
      return say(
        `disconnected: ${String(event.reason)}${event.willReconnect === true ? ` — retrying in ${String(event.retryInMs)}ms` : ""}`,
      );
    case "closed":
      return say(`session closed: ${String(event.reason)}`);
    case "fatal":
      // Not printed here: it becomes the CliError this command exits with, and
      // the runtime reports that on stderr. Printing both said it twice.
      return;
    case "error":
      return say(String(event.message));
    default:
      return say(`${event.type}: ${JSON.stringify(event)}`);
  }
}

function exitCodeFor(code: number): ExitCodeValue {
  if (code === ExitCode.Remote) return ExitCode.Remote;
  // Anything the runner did not classify as remote is the caller's to fix, and
  // repeating it would only repeat the failure.
  return ExitCode.Config;
}

export async function devConnect(
  args: string[],
  context: CommandContext | undefined,
  deps: DevCommandDependencies,
): Promise<void> {
  const slug = requireDevSlug(args, "connect");
  const options = args.slice(1);
  assertKnown(
    options,
    { value: ["--dir", "--tools", "--hooks", "--token-env", "--token-file"], boolean: ["--watch"] },
    "dev connect option",
  );

  const given = takeValue(options, "--dir");
  const directory = given === undefined ? deps.cwd() : isAbsolute(given) ? given : resolve(deps.cwd(), given);
  const token = await resolveToken(options, deps, slug);
  const tsx = await requireProject(deps, directory);
  const paths = toolPaths(options, directory);
  const hookPaths = pathsFor(options, "--hooks", directory);

  // One read before the socket: it proves the agent exists and that this key may
  // drive its dev mode, and it says whether a session is already connected —
  // which the new connection is about to displace. The engine's own single-node
  // caveat rides along with it.
  const scope = await scopeFor(deps, context, "read");
  const status = await call(deps, scope, { path: agentPath(slug, "/dev-session") });
  const body = status.body as DevSessionStatus | null;
  if (body?.session != null) {
    deps.io.stderr(
      `note: session ${String(body.session.sessionId)} is already connected to ${slug} — connecting closes it.\n`,
    );
  }
  warnAboutNode(deps, body);

  const child = deps.spawn({
    command: tsx,
    // The source, not a path: a file inside the CLI's dist would resolve the SDK
    // in the CLI's node_modules. `-e` code resolves from the cwd instead.
    args: ["-e", DEV_RUNNER_SOURCE],
    cwd: directory,
    env: {
      ...deps.env,
      [DEV_RUNNER_ENV.token]: token,
      [DEV_RUNNER_ENV.agent]: slug,
      [DEV_RUNNER_ENV.baseUrl]: scope.target.baseUrl,
      [DEV_RUNNER_ENV.paths]: JSON.stringify(paths),
      [DEV_RUNNER_ENV.hookPaths]: JSON.stringify(hookPaths),
      ...(options.includes("--watch") ? { [DEV_RUNNER_ENV.watch]: "1" } : {}),
    },
  });

  const json = wantsJson(context);
  let fatal: string | undefined;
  child.onStdoutLine((line) => {
    if (!line.startsWith(DEV_EVENT_MARKER)) {
      // The operator's own tool wrote this. It is a diagnostic, not the answer,
      // so it never lands on stdout — where in --json mode it would break the
      // one-object-per-line contract.
      if (line.length > 0) deps.io.stderr(`tool: ${line}\n`);
      return;
    }
    const payload = line.slice(DEV_EVENT_MARKER.length);
    let event: SessionEvent;
    try {
      event = JSON.parse(payload) as SessionEvent;
    } catch {
      deps.io.stderr(`unparseable event from the dev runner: ${payload}\n`);
      return;
    }
    if (event.type === "fatal") fatal = String(event.message);
    if (json) return deps.io.stdout(`${payload}\n`);
    renderEvent(deps, event);
  });
  child.onStderrLine((line) => {
    if (line.length > 0) deps.io.stderr(`${line}\n`);
  });

  // The interrupt reaches the child too (it shares the terminal's process
  // group), but asking it explicitly is what makes a non-interactive caller's
  // SIGINT close the session cleanly rather than orphan it.
  const release = deps.onInterrupt(() => child.stop());
  try {
    const code = await child.exited;
    if (code !== 0) throw new CliError(fatal ?? `dev connect: the local runner exited with ${code}.`, exitCodeFor(code));
  } finally {
    release();
  }
}
