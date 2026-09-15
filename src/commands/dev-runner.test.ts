// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it } from "vitest";
import { DEV_EVENT_MARKER, DEV_RUNNER_ENV, DEV_RUNNER_SOURCE } from "./dev-runner.js";

/**
 * These assert the properties that make the runner resolve the SDK in the
 * OPERATOR's project rather than in the CLI's own node_modules. Each one is a
 * mistake that would work on the author's machine and fail on everyone else's,
 * or fail only once a real `tsx` ran it — which no unit test does.
 *
 * The behaviour itself was verified against a real `tsx` in a scratch project;
 * `the design notes` records
 * the commands and their output.
 */
describe("the dev runner source", () => {
  it("imports the SDK by bare specifier only, never by path", () => {
    expect(DEV_RUNNER_SOURCE).toContain('await import("@polyant-ai/plugin-sdk/dev")');
    // A relative or absolute specifier would resolve against the CLI's dist,
    // where the SDK is not installed and must not be.
    expect(DEV_RUNNER_SOURCE).not.toMatch(/import\(["'][./]/);
    expect(DEV_RUNNER_SOURCE).not.toContain("node_modules");
  });

  // `tsx -e` compiles its input as CJS, which rejects top-level await outright:
  // "Top-level await is currently not supported with the cjs output format".
  it("keeps every await inside the async IIFE", () => {
    expect(DEV_RUNNER_SOURCE.trimStart()).toMatch(/^void \(async \(\) => \{/);
    expect(DEV_RUNNER_SOURCE).not.toMatch(/^await /m);
    expect(DEV_RUNNER_SOURCE).not.toMatch(/^(const|let) \w+ = await /m);
  });

  it("takes the token from the environment, and reads no argument at all", () => {
    expect(DEV_RUNNER_SOURCE).toContain(`env[${JSON.stringify(DEV_RUNNER_ENV.token)}]`);
    expect(DEV_RUNNER_SOURCE).not.toContain("process.argv");
  });

  // The path is the engine's contract, and the SDK is the one place it is
  // written down. A literal here would be a second copy to forget.
  it("takes the socket path from the SDK, not from a literal", () => {
    expect(DEV_RUNNER_SOURCE).toContain("dev.DEV_SOCKET_PATH");
    expect(DEV_RUNNER_SOURCE).not.toContain("/dev-mode/socket");
  });

  it("marks every event line, so a tool's own output cannot pass for one", () => {
    expect(DEV_RUNNER_SOURCE).toContain(`const MARKER = ${JSON.stringify(DEV_EVENT_MARKER)}`);
    expect(DEV_RUNNER_SOURCE).toContain("MARKER + JSON.stringify(event)");
  });

  // A refused handshake is not retryable and an unreachable engine is: the
  // runner classifies its own failure so the CLI never sniffs a message for it.
  it("classifies its own exit code", () => {
    expect(DEV_RUNNER_SOURCE).toContain("fatal(rejected ? 2 : 3, reason(err))");
    expect(DEV_RUNNER_SOURCE).toContain("process.exitCode = exitCode");
    // process.exit would discard the event lines still buffered in the pipe.
    expect(DEV_RUNNER_SOURCE).not.toContain("process.exit(");
  });

  // An SDK older than 1.8 has no hook loader. The runner degrades to tools
  // only instead of dying on an undefined function, because a project pinned to
  // an older SDK is a normal state, not a broken one.
  it("degrades to tools only against an SDK with no hook support", () => {
    expect(DEV_RUNNER_SOURCE).toContain("dev.loadHooksFromPaths ?");
    expect(DEV_RUNNER_SOURCE).toContain("handle.updateHooks");
  });

  // A project may be all hooks and no tools: neither alone is the floor.
  it("refuses to start only when there is neither a tool nor a hook", () => {
    expect(DEV_RUNNER_SOURCE).toContain("tools.length === 0 && hooks.length === 0");
  });

  // Tools and hooks default to the same directory, so watching the list as
  // given would fire every reload twice.
  it("de-duplicates the watched paths", () => {
    expect(DEV_RUNNER_SOURCE).toContain("new Set(paths.concat(hookPaths))");
  });

  it("is valid JavaScript", () => {
    // Parsed, not run: a syntax error would otherwise surface as a child that
    // died with an exit code and no explanation.
    expect(() => new Function(DEV_RUNNER_SOURCE)).not.toThrow();
  });
});
