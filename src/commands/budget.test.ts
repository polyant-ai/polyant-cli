// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import { createAgentCommand, type AgentCommandDependencies } from "./agent.js";

/** The agent's spend caps and the providers it may be pointed at (engine 1.2.0). */

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" } },
  contexts: { dev: { target: "dev", org: "acme", workspace: "ws-1" } },
  defaultContext: "dev",
};

function response(body: unknown, status = 200): ApiResponse {
  return { status, raw: JSON.stringify(body), body };
}

function harness(responses: ApiResponse[], overrides: Partial<AgentCommandDependencies> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RequestOptions[] = [];
  const queue = [...responses];
  const request = vi.fn(async (_target: unknown, opts: RequestOptions) => {
    calls.push(opts);
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected request: ${opts.method ?? "GET"} ${opts.path}`);
    return next;
  });
  const agent = createAgentCommand({
    request: request as unknown as AgentCommandDependencies["request"],
    loadConfig: async () => CONFIG,
    env: { POLYANT_KEY_DEV: "pk_dev_secret" },
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
    ...overrides,
  });
  return { agent, out, err, calls };
}

function context(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["agent"], global: { json: false, yes: false, dryRun: false, ...global } };
}

function leaf(command: Command, path: string[]) {
  let node: Command | undefined = command;
  for (const segment of path) node = node?.children?.[segment];
  if (node?.run === undefined) throw new Error(`No such action: ${path.join(" ")}`);
  return node.run.bind(node);
}

const BUDGET = {
  limits: { conversationUsd: 2, periods: { day: 20 }, contactPeriods: { day: 1 } },
  stopMessage: "Limit reached.",
  stopMessageIsDefault: false,
  windows: [{ period: "day", limitUsd: 20, spentUsd: 3.5 }],
};

describe("agent budget show", () => {
  it("prints the caps and what the current window has cost", async () => {
    const h = harness([response(BUDGET)]);

    await leaf(h.agent, ["budget", "show"])(["acme"], context());

    expect(h.calls[0].path).toBe("/api/instances/acme/budget");
    const text = h.out.join("");
    expect(text).toContain("per conversation:  $2.00");
    expect(text).toContain("per contact:       day $1.00");
    expect(text).toMatch(/day\s+\$20\.00\s+\$3\.50/);
  });

  it("says an agent with no agent-wide cap has none", async () => {
    const h = harness([response({ limits: {}, stopMessage: "x", stopMessageIsDefault: true, windows: [] })]);

    await leaf(h.agent, ["budget", "show"])(["acme"], context());

    expect(h.out.join("")).toContain("Agent acme has no agent-wide spend cap.");
    expect(h.out.join("")).toContain("(default)");
  });
});

describe("agent budget set", () => {
  const payload = (body: unknown) => ({ readPayload: async () => JSON.stringify(body) });

  it("sends the payload unchanged and says the caps are soft", async () => {
    const body = { limits: BUDGET.limits, stopMessage: "Limit reached." };
    const h = harness([response({ saved: true })], payload(body));

    await leaf(h.agent, ["budget", "set"])(["acme", "--file", "budget.json"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ method: "PUT", path: "/api/instances/acme/budget", body });
    const recap = h.err.join("");
    expect(recap).toContain("Stop a conversation once it has cost $2.00.");
    expect(recap).toContain("a cap it does not name is removed");
    expect(recap).toContain("Soft caps");
    expect(recap).toContain("custom stop message: 14 characters from budget.json");
    expect(recap).not.toContain("Limit reached.");
  });

  it("says an empty policy removes every cap", async () => {
    const h = harness([response({ saved: true })], payload({ limits: {} }));

    await leaf(h.agent, ["budget", "set"])(["acme", "--file", "-"], context({ yes: true }));

    expect(h.err.join("")).toContain("Remove every spend cap from acme");
  });

  it.each([
    [{ limits: { periods: { daily: 5 } } }, /limits\.periods\.daily is not a period/],
    [{ limits: { periods: { day: 0 } } }, /limits\.periods\.day must be a positive number/],
    [{ limits: { conversationUsd: "2" } }, /conversationUsd must be a positive number/],
    [{ limits: { monthly: 5 } }, /limits\.monthly is not a budget field/],
    [{ limits: {}, stop: "x" }, /stop is not one of them/],
    [{}, /needs limits as an object/],
  ])("refuses %j before sending anything", async (body, message) => {
    const h = harness([], payload(body));

    await expect(leaf(h.agent, ["budget", "set"])(["acme", "--file", "b.json"], context({ yes: true }))).rejects.toThrow(message);
    expect(h.calls).toEqual([]);
  });

  it("sends nothing on a dry run", async () => {
    const h = harness([], payload({ limits: { periods: { month: 100 } } }));

    await leaf(h.agent, ["budget", "set"])(["acme", "--file", "b.json"], context({ dryRun: true }));

    expect(h.calls).toEqual([]);
  });
});

describe("agent providers", () => {
  it("reads the agent's own view and lists only the connections lent to its workspace", async () => {
    const h = harness([
      response({
        managedConnectionsOnly: true,
        providers: [
          { provider: "anthropic", admitted: true },
          { provider: "openai", admitted: false },
        ],
        disabledModels: { organization: ["openai/gpt-4o"], workspace: [] },
        connections: [{ id: "c-1", name: "Prod", provider: "anthropic", configuredFields: ["apiKey"], assigned: true }],
      }),
    ]);

    await leaf(h.agent, ["providers"])(["acme"], context());

    expect(h.calls[0].path).toBe("/api/instances/acme/providers");
    const text = h.out.join("");
    expect(text).toMatch(/anthropic\s+yes/);
    expect(text).toMatch(/openai\s+no/);
    expect(text).toContain("openai/gpt-4o");
    expect(text).toContain("managed connections only:   yes");
    // Every row the agent read returns is usable, so there is no ASSIGNED column.
    expect(text).toMatch(/c-1\s+Prod\s+anthropic\s+apiKey\s*\n/);
    expect(text).not.toContain("ASSIGNED");
  });
});
