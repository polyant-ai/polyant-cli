// SPDX-License-Identifier: Apache-2.0

/**
 * The shared harness for the three dev command families. A `.test-harness.ts`
 * file rather than a `.test.ts` one on purpose: importing a test FILE re-runs
 * every suite it declares, once per importer.
 */
import { vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import { ExitCode, RemoteError } from "../exit.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import { createDevCommand, type DevCommandDependencies } from "./dev.js";

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" } },
  contexts: { dev: { target: "dev", org: "acme", workspace: "ws-1" } },
  defaultContext: "dev",
};

export function response(body: unknown, status = 200): ApiResponse {
  return { status, raw: JSON.stringify(body), body };
}

export function devHarness(responses: ApiResponse[], overrides: Partial<DevCommandDependencies> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RequestOptions[] = [];
  const files = new Map<string, string>();
  const queue = [...responses];
  const request = vi.fn(async (_target: unknown, opts: RequestOptions) => {
    calls.push(opts);
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected request: ${opts.method ?? "GET"} ${opts.path}`);
    return next;
  });
  const command = createDevCommand({
    request: request as unknown as DevCommandDependencies["request"],
    loadConfig: async () => CONFIG,
    env: { POLYANT_KEY_DEV: "pk_dev_secret" },
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
    fs: {
      readFile: async (path) => {
        const found = files.get(path);
        if (found === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return found;
      },
      writeFile: async (path, text) => {
        files.set(path, text);
      },
      mkdir: async () => undefined,
      exists: async (path) => files.has(path),
    },
    cwd: () => "/work/tools",
    spawn: () => {
      throw new Error("spawn is not expected here");
    },
    onInterrupt: () => () => undefined,
    ...overrides,
  });
  return { command, out, err, calls, files };
}

export function devContext(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["dev"], global: { json: false, yes: false, dryRun: false, ...global } };
}

export function leaf(command: Command, path: string[]) {
  let node: Command | undefined = command;
  for (const segment of path) node = node?.children?.[segment];
  if (node?.run === undefined) throw new Error(`No such dev action: ${path.join(" ")}`);
  return node.run.bind(node);
}
