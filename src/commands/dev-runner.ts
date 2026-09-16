// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise

/**
 * The child-process runner for `dev connect`, as source text.
 *
 * WHY A STRING, AND WHY `tsx -e`
 *
 * Importing the operator's `*.tool.ts` files needs a process that can load
 * TypeScript, which this compiled CLI is not. So `dev connect` spawns the
 * project's own `tsx`. The trap is module resolution: a bare
 * `import "@polyant-ai/plugin-sdk/dev"` written in a FILE inside the CLI's
 * `dist/` resolves against that file's location — the CLI's `node_modules` —
 * where the SDK is not installed and must not be. It has to resolve in the
 * operator's project instead.
 *
 * `tsx -e <source>` compiles the code as if it sat in the CURRENT WORKING
 * DIRECTORY, so a bare specifier resolves from the project the child was
 * started in. That is verified, not assumed: the same command run from another
 * cwd fails with ERR_MODULE_NOT_FOUND, and the transcript of both runs is in
 * `the design notes`.
 * `dev-runner.test.ts` pins the properties that make it hold.
 *
 * Two consequences shape the code below:
 *
 *  - `tsx -e` compiles to CJS, which rejects top-level `await`. Everything is
 *    inside one async IIFE, and every import is dynamic.
 *  - Nothing is hardcoded here that the SDK owns. The socket path comes from
 *    `DEV_SOCKET_PATH`, so a protocol move is the SDK's to make.
 *
 * The token arrives in the environment, never in argv: `-e` source and every
 * other argument are visible in `ps`.
 */

/** Environment variables the runner reads. The token is one of them, deliberately. */
export const DEV_RUNNER_ENV = {
  token: "POLYANT_DEV_TOKEN",
  agent: "POLYANT_DEV_AGENT",
  baseUrl: "POLYANT_DEV_BASE_URL",
  paths: "POLYANT_DEV_PATHS",
  hookPaths: "POLYANT_DEV_HOOK_PATHS",
  watch: "POLYANT_DEV_WATCH",
} as const;

/**
 * Prefix marking a line on the child's stdout as a session event rather than
 * output from the operator's own tool code. Without it a `console.log` inside a
 * tool that happens to print JSON would be parsed as an event; with it, every
 * unmarked line is forwarded as what it is — the tool's own output.
 */
export const DEV_EVENT_MARKER = "polyant-dev";

/**
 * Events the runner adds to the SDK's own set. `fatal` carries the exit code so
 * the CLI never has to infer one from an error message.
 */
export interface DevFatalEvent {
  readonly type: "fatal";
  readonly exitCode: 2 | 3;
  readonly message: string;
}

export const DEV_RUNNER_SOURCE = `
void (async () => {
  const MARKER = ${JSON.stringify(DEV_EVENT_MARKER)};
  const env = process.env;
  const emit = (event) => process.stdout.write(MARKER + JSON.stringify(event) + "\\n");
  const reason = (err) => (err instanceof Error ? err.message : String(err));
  // No process.exit: a pipe is asynchronous, and exiting discards whatever the
  // event lines have not flushed yet. Setting exitCode lets the loop drain.
  const fatal = (exitCode, message) => {
    emit({ type: "fatal", exitCode, message });
    process.exitCode = exitCode;
  };

  const token = env[${JSON.stringify(DEV_RUNNER_ENV.token)}];
  const agentSlug = env[${JSON.stringify(DEV_RUNNER_ENV.agent)}];
  const baseUrl = env[${JSON.stringify(DEV_RUNNER_ENV.baseUrl)}];
  const watch = env[${JSON.stringify(DEV_RUNNER_ENV.watch)}] === "1";
  let paths;
  let hookPaths;
  try {
    paths = JSON.parse(env[${JSON.stringify(DEV_RUNNER_ENV.paths)}] || "[]");
    hookPaths = JSON.parse(env[${JSON.stringify(DEV_RUNNER_ENV.hookPaths)}] || "[]");
  } catch (err) {
    return fatal(2, "could not read the tool paths: " + reason(err));
  }
  if (!token || !agentSlug || !baseUrl || paths.length === 0) {
    return fatal(2, "the dev runner was started without its environment (token, agent, base URL, paths).");
  }

  let dev;
  try {
    dev = await import("@polyant-ai/plugin-sdk/dev");
  } catch (err) {
    return fatal(
      2,
      "cannot import @polyant-ai/plugin-sdk/dev from " + process.cwd() + ": " + reason(err) +
        " — install the SDK in this project (polyant-cli dev init writes it into package.json).",
    );
  }

  let tools;
  let hooks;
  try {
    tools = await dev.loadToolsFromPaths(paths, { cacheBust: watch });
    // \`loadHooksFromPaths\` arrived in SDK 1.8: an older SDK in the project has
    // tools and no hooks, which is the state to degrade into rather than crash.
    // Silently, though, a project written against the hook feature looks like
    // one whose hooks the engine declined — so say which it is, once, when the
    // project actually has hook files to lose.
    if (!dev.loadHooksFromPaths && hookPaths.length > 0) {
      process.stderr.write(
        "note: this project's @polyant-ai/plugin-sdk predates 1.8 and cannot load hooks — " +
          "its *.hook.ts files will not be served. Update the SDK dependency to serve them.\\n",
      );
    }
    hooks = dev.loadHooksFromPaths ? await dev.loadHooksFromPaths(hookPaths, { cacheBust: watch }) : [];
  } catch (err) {
    return fatal(2, reason(err));
  }
  // A project may be all hooks and no tools, so neither alone is the floor.
  if (tools.length === 0 && hooks.length === 0) {
    return fatal(2, "no *.tool.ts or *.hook.ts files under " + paths.concat(hookPaths).join(", ") + ".");
  }

  // The scheme is ours to translate; the PATH is the SDK's to own.
  const socketUrl = (() => {
    const url = new URL(baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const prefix = url.pathname === "/" ? "" : url.pathname.replace(/\\/$/, "");
    url.pathname = prefix + dev.DEV_SOCKET_PATH;
    return url.toString();
  })();

  // Node 20 and 21 have no global WebSocket. \`ws\` is not a dependency of
  // anything here, so it is used only if the project happens to carry it;
  // otherwise the SDK's own error names the remedy.
  let webSocketImpl;
  if (typeof globalThis.WebSocket !== "function") {
    try {
      const ws = await import("ws");
      const Ctor = ws.default || ws.WebSocket;
      webSocketImpl = (url) => new Ctor(url);
    } catch {
      /* let serveDevSession report the absence */
    }
  }

  let rejected = false;
  let handle;
  try {
    handle = await dev.serveDevSession({
      agentSlug,
      token,
      url: socketUrl,
      tools,
      hooks,
      onEvent: (event) => {
        if (event.type === "handshake_rejected") rejected = true;
        emit(event);
      },
      ...(webSocketImpl ? { webSocketImpl } : {}),
    });
  } catch (err) {
    // A refused handshake is a wrong token, agent or protocol version: the
    // caller's fault, and retrying cannot fix it. Anything else at this point
    // is an engine that could not be reached, which is retryable.
    return fatal(rejected ? 2 : 3, reason(err));
  }

  // A REF'd timer, deliberately: the SDK unrefs its reconnection timer, so with
  // nothing else holding the loop the process would exit 0 right after
  // announcing "willReconnect" — a session that reports a retry and then
  // silently stops. This is what keeps the retry alive.
  const keepAlive = setInterval(() => undefined, 60_000);

  const watchers = [];
  let closing = false;
  const shutdown = (why) => {
    if (closing) return;
    closing = true;
    clearInterval(keepAlive);
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
    handle.close(why);
    process.exitCode = 0;
  };
  process.on("SIGINT", () => shutdown("interrupted"));
  process.on("SIGTERM", () => shutdown("terminated"));

  if (watch) {
    const { watch: watchPath } = await import("node:fs");
    let timer = null;
    const reload = () => {
      if (timer) clearTimeout(timer);
      // Debounced: one editor save fires several change events, and a save in
      // progress can be read half-written.
      timer = setTimeout(async () => {
        timer = null;
        if (closing) return;
        try {
          handle.updateTools(await dev.loadToolsFromPaths(paths, { cacheBust: true }));
          if (dev.loadHooksFromPaths && handle.updateHooks) {
            handle.updateHooks(await dev.loadHooksFromPaths(hookPaths, { cacheBust: true }));
          }
        } catch (err) {
          // A syntax error must not end the session: the previous tool set stays
          // served and the next save is another chance.
          emit({ type: "reload_failed", message: reason(err) });
        }
      }, 150);
    };
    // De-duplicated: tool and hook paths are the same directory by default, and
    // watching it twice would fire every reload twice.
    const watched = [...new Set(paths.concat(hookPaths))];
    for (const path of watched) {
      try {
        watchers.push(watchPath(path, { recursive: true }, reload));
      } catch (err) {
        emit({ type: "error", message: "cannot watch " + path + ": " + reason(err) });
      }
    }
    emit({ type: "watching", paths: watched });
  }
})();
`;
