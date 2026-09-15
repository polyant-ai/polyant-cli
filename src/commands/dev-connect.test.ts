// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import { ExitCode } from "../exit.js";
import type { DevChildProcess, DevCommandDependencies, DevSpawnOptions } from "./dev.js";
import { DEV_EVENT_MARKER, DEV_RUNNER_ENV, DEV_RUNNER_SOURCE } from "./dev-runner.js";
import { devContext, devHarness, leaf, response } from "./dev.test-harness.js";

const IDLE = { session: null, nodeWarning: true };
const TOKEN = "pdt_live_secret";

/** A child under the test's control: lines in, exit code out. */
function fakeChild() {
  let onStdout: (line: string) => void = () => undefined;
  let onStderr: (line: string) => void = () => undefined;
  let finish: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  let stops = 0;
  const child: DevChildProcess = {
    exited,
    onStdoutLine: (listener) => {
      onStdout = listener;
    },
    onStderrLine: (listener) => {
      onStderr = listener;
    },
    stop: () => {
      stops += 1;
    },
  };
  return {
    child,
    event: (event: unknown) => onStdout(`${DEV_EVENT_MARKER}${JSON.stringify(event)}`),
    stdoutLine: (line: string) => onStdout(line),
    stderrLine: (line: string) => onStderr(line),
    exit: (code: number) => finish(code),
    stops: () => stops,
  };
}

function connectHarness(overrides: Partial<DevCommandDependencies> = {}) {
  const fake = fakeChild();
  let spawned: DevSpawnOptions | undefined;
  const h = devHarness([response(IDLE)], {
    env: { POLYANT_KEY_DEV: "pk_dev_secret", POLYANT_DEV_TOKEN: TOKEN },
    spawn: (options) => {
      spawned = options;
      return fake.child;
    },
    ...overrides,
  });
  // The project the child will be started in: both of these must resolve there.
  h.files.set("/work/tools/node_modules/.bin/tsx", "#!/bin/sh");
  h.files.set("/work/tools/node_modules/@polyant-ai/plugin-sdk/package.json", "{}");
  return { ...h, fake, spawnedOptions: () => spawned };
}

/**
 * Starts the command and returns once the child has been spawned. The outcome
 * is returned WRAPPED: an async function that returned the promise itself would
 * adopt it, and the caller would be waiting for a child it has not driven yet.
 */
async function start(h: ReturnType<typeof connectHarness>, args: string[], global: Parameters<typeof devContext>[0] = {}) {
  const running = leaf(h.command, ["connect"])(args, devContext(global));
  // Swallowed here and re-asserted by the caller: an unhandled rejection while
  // the test is still driving the child would fail the run for the wrong reason.
  const settled = running.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.waitFor(() => expect(h.spawnedOptions()).toBeDefined());
  return { settled };
}

describe("dev connect: what it refuses before spawning anything", () => {
  it("names the environment variable when no token is available", async () => {
    const h = connectHarness({ env: { POLYANT_KEY_DEV: "pk_dev_secret" } });

    await expect(leaf(h.command, ["connect"])(["acme"], devContext())).rejects.toThrow(
      /\$POLYANT_DEV_TOKEN is unset or empty/,
    );
    expect(h.spawnedOptions()).toBeUndefined();
  });

  it("has no --token flag, and says why", async () => {
    const h = connectHarness();

    await expect(leaf(h.command, ["connect"])(["acme", "--token", TOKEN], devContext())).rejects.toThrow(
      /Unknown dev connect option --token/,
    );
  });

  it("reports a project without tsx as a project problem", async () => {
    const h = connectHarness();
    h.files.delete("/work/tools/node_modules/.bin/tsx");

    await expect(leaf(h.command, ["connect"])(["acme"], devContext())).rejects.toThrow(
      /has no node_modules\/\.bin\/tsx/,
    );
  });

  it("reports a project without the SDK as a project problem", async () => {
    const h = connectHarness();
    h.files.delete("/work/tools/node_modules/@polyant-ai/plugin-sdk/package.json");

    await expect(leaf(h.command, ["connect"])(["acme"], devContext())).rejects.toThrow(
      /has no node_modules\/@polyant-ai\/plugin-sdk/,
    );
  });
});

describe("dev connect: how the child is started", () => {
  it("runs the project's own tsx, with the runner as -e source and the project as cwd", async () => {
    const h = connectHarness();

    const { settled } = await start(h, ["acme"]);
    h.fake.exit(0);
    expect(await settled).toEqual({ ok: true });

    const options = h.spawnedOptions();
    expect(options?.command).toBe("/work/tools/node_modules/.bin/tsx");
    expect(options?.args).toEqual(["-e", DEV_RUNNER_SOURCE]);
    // The cwd is the whole mechanism: `tsx -e` resolves a bare specifier from
    // it, which is the only place the operator's SDK is installed.
    expect(options?.cwd).toBe("/work/tools");
  });

  // argv is visible in `ps`, and this CLI has no flag that puts a secret there.
  it("passes the token in the environment and never in argv", async () => {
    const h = connectHarness();

    const { settled } = await start(h, ["acme"]);
    h.fake.exit(0);
    await settled;

    const options = h.spawnedOptions();
    expect(options?.env[DEV_RUNNER_ENV.token]).toBe(TOKEN);
    expect(JSON.stringify(options?.args)).not.toContain(TOKEN);
    expect(options?.env[DEV_RUNNER_ENV.agent]).toBe("acme");
    expect(options?.env[DEV_RUNNER_ENV.baseUrl]).toBe("http://localhost:4000");
    expect(JSON.parse(options?.env[DEV_RUNNER_ENV.paths] as string)).toEqual(["/work/tools"]);
  });

  it("reads the token from a file when asked, so a pipe can carry it", async () => {
    const h = connectHarness({
      env: { POLYANT_KEY_DEV: "pk_dev_secret" },
      readPayload: async () => `${TOKEN}\n`,
    });

    const { settled } = await start(h, ["acme", "--token-file", "-"]);
    h.fake.exit(0);
    await settled;

    expect(h.spawnedOptions()?.env[DEV_RUNNER_ENV.token]).toBe(TOKEN);
  });

  it("asks for the hot reload only when --watch says so", async () => {
    const watching = connectHarness();
    const { settled: settledWatch } = await start(watching, ["acme", "--watch"]);
    watching.fake.exit(0);
    await settledWatch;
    expect(watching.spawnedOptions()?.env[DEV_RUNNER_ENV.watch]).toBe("1");

    const plain = connectHarness();
    const { settled } = await start(plain, ["acme"]);
    plain.fake.exit(0);
    await settled;
    expect(plain.spawnedOptions()?.env[DEV_RUNNER_ENV.watch]).toBeUndefined();
  });

  it("resolves --tools against the project directory", async () => {
    const h = connectHarness();
    h.files.set("/srv/kit/node_modules/.bin/tsx", "#!/bin/sh");
    h.files.set("/srv/kit/node_modules/@polyant-ai/plugin-sdk/package.json", "{}");

    const { settled } = await start(h, ["acme", "--dir", "/srv/kit", "--tools", "src/tools"]);
    h.fake.exit(0);
    await settled;

    expect(h.spawnedOptions()?.command).toBe("/srv/kit/node_modules/.bin/tsx");
    expect(h.spawnedOptions()?.cwd).toBe("/srv/kit");
    expect(JSON.parse(h.spawnedOptions()?.env[DEV_RUNNER_ENV.paths] as string)).toEqual(["/srv/kit/src/tools"]);
  });

  it("defaults hooks to the project directory, the same as tools", async () => {
    // One tree holding both needs no option: each loader matches its own
    // filename suffix.
    const h = connectHarness();
    const { settled } = await start(h, ["acme"]);
    h.fake.exit(0);
    await settled;

    expect(JSON.parse(h.spawnedOptions()?.env[DEV_RUNNER_ENV.hookPaths] as string)).toEqual(["/work/tools"]);
  });

  it("resolves --hooks against the project directory, independently of --tools", async () => {
    const h = connectHarness();
    h.files.set("/srv/kit/node_modules/.bin/tsx", "#!/bin/sh");
    h.files.set("/srv/kit/node_modules/@polyant-ai/plugin-sdk/package.json", "{}");

    const { settled } = await start(h, [
      "acme", "--dir", "/srv/kit", "--tools", "src/tools", "--hooks", "src/hooks",
    ]);
    h.fake.exit(0);
    await settled;

    expect(JSON.parse(h.spawnedOptions()?.env[DEV_RUNNER_ENV.paths] as string)).toEqual(["/srv/kit/src/tools"]);
    expect(JSON.parse(h.spawnedOptions()?.env[DEV_RUNNER_ENV.hookPaths] as string)).toEqual(["/srv/kit/src/hooks"]);
  });
});

describe("dev connect: the preflight read", () => {
  it("says that connecting displaces a session that is already live", async () => {
    const h = devHarness([response({ session: { sessionId: "ds_old" }, nodeWarning: true })], {
      env: { POLYANT_KEY_DEV: "pk_dev_secret", POLYANT_DEV_TOKEN: TOKEN },
      spawn: () => fakeChild().child,
    });
    h.files.set("/work/tools/node_modules/.bin/tsx", "#!/bin/sh");
    h.files.set("/work/tools/node_modules/@polyant-ai/plugin-sdk/package.json", "{}");

    void leaf(h.command, ["connect"])(["acme"], devContext());
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));

    expect(h.calls[0]).toMatchObject({ path: "/api/instances/acme/dev-session" });
    expect(h.err.join("")).toContain("ds_old is already connected to acme — connecting closes it");
    expect(h.err.join("")).toContain("ONE engine node");
  });
});

describe("dev connect: the output contract", () => {
  it("puts the tool calls on stdout and the session's own life on stderr", async () => {
    const h = connectHarness();

    const { settled } = await start(h, ["acme"]);
    h.fake.event({ type: "connected", sessionId: "ds_1", engineVersion: "1.4.0", warnings: ["renamed"], tools: ["local_echo"] });
    h.fake.event({ type: "invoke", callId: "c1", tool: "local_echo" });
    h.fake.event({ type: "result", callId: "c1", tool: "local_echo", ok: true, durationMs: 12 });
    h.fake.exit(0);
    expect(await settled).toEqual({ ok: true });

    expect(h.out.join("")).toBe("→ local_echo (c1)\n← local_echo ok 12ms\n");
    const stderr = h.err.join("");
    expect(stderr).toContain("connected: session ds_1, engine 1.4.0, serving 1 tool(s): local_echo");
    expect(stderr).toContain("warning: renamed");
  });

  it("emits one JSON object per line under --json, unmodified", async () => {
    const h = connectHarness();

    const { settled } = await start(h, ["acme"], { json: true });
    h.fake.event({ type: "connected", sessionId: "ds_1", engineVersion: "1.4.0", warnings: [], tools: [] });
    h.fake.event({ type: "invoke", callId: "c1", tool: "local_echo" });
    h.fake.exit(0);
    await settled;

    const lines = h.out.join("").trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line) as { type: string })).toEqual([
      { type: "connected", sessionId: "ds_1", engineVersion: "1.4.0", warnings: [], tools: [] },
      { type: "invoke", callId: "c1", tool: "local_echo" },
    ]);
  });

  /**
   * A `console.log` inside the operator's own tool arrives on the same stream as
   * the events. It is a diagnostic, so it goes to stderr — and under `--json` it
   * would otherwise break the one-object-per-line contract outright.
   */
  it("keeps the tool's own output off stdout", async () => {
    const h = connectHarness();

    const { settled } = await start(h, ["acme"], { json: true });
    h.fake.stdoutLine('{"type":"invoke","tool":"forged"}');
    h.fake.stderrLine("some warning from the tool");
    h.fake.exit(0);
    await settled;

    expect(h.out.join("")).toBe("");
    expect(h.err.join("")).toContain('tool: {"type":"invoke","tool":"forged"}');
    expect(h.err.join("")).toContain("some warning from the tool");
  });
});

describe("dev connect: exit codes", () => {
  it("reports a refused handshake as configuration, with the runner's message", async () => {
    const h = connectHarness();

    const { settled } = await start(h, ["acme"]);
    h.fake.event({ type: "handshake_rejected", reason: "invalid token" });
    h.fake.event({ type: "fatal", exitCode: 2, message: "dev handshake rejected: invalid token" });
    h.fake.exit(2);

    const outcome = await settled;
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { error: { code: number; message: string } }).error).toMatchObject({
      code: ExitCode.Config,
      message: "dev handshake rejected: invalid token",
    });
  });

  // The message travels as the command's own failure, which the runtime prints.
  // Rendering the event too reported the same line twice.
  it("does not print the fatal message and then repeat it as the error", async () => {
    const h = connectHarness();

    const { settled } = await start(h, ["acme"]);
    h.fake.event({ type: "fatal", exitCode: 2, message: "dev handshake rejected: invalid token" });
    h.fake.exit(2);
    await settled;

    expect(h.err.join("")).not.toContain("dev handshake rejected");
  });

  it("reports an unreachable engine as retryable", async () => {
    const h = connectHarness();

    const { settled } = await start(h, ["acme"]);
    h.fake.event({ type: "fatal", exitCode: 3, message: "could not connect to ws://localhost:4000/dev-mode/socket" });
    h.fake.exit(3);

    const outcome = await settled;
    expect((outcome as { error: { code: number } }).error).toMatchObject({ code: ExitCode.Remote });
  });

  it("succeeds when the operator interrupts it", async () => {
    const handlers: Array<() => void> = [];
    const interrupting = connectHarness({
      onInterrupt: (handler) => {
        handlers.push(handler);
        return () => undefined;
      },
    });
    const { settled } = await start(interrupting, ["acme"]);
    handlers[0]?.();
    expect(interrupting.fake.stops()).toBe(1);
    interrupting.fake.event({ type: "closed", reason: "interrupted" });
    interrupting.fake.exit(0);

    expect(await settled).toEqual({ ok: true });
  });

  it("still fails when the runner dies without saying why", async () => {
    const h = connectHarness();

    const { settled } = await start(h, ["acme"]);
    h.fake.exit(1);

    const outcome = await settled;
    expect((outcome as { error: { code: number; message: string } }).error).toMatchObject({
      code: ExitCode.Config,
      message: "dev connect: the local runner exited with 1.",
    });
  });
});
