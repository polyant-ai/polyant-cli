// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import type { AgentCommandDependencies } from "./agent.js";
import { createAgentCommand } from "./agent.js";

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" } },
  contexts: { dev: { target: "dev", org: "acme", workspace: "ws-1" } },
  defaultContext: "dev",
};
const ENV = { POLYANT_KEY_DEV: "pk_dev_secret" };

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
  const command = createAgentCommand({
    request: request as unknown as AgentCommandDependencies["request"],
    loadConfig: async () => CONFIG,
    env: ENV,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
    ...overrides,
  });
  return { command, request, out, err, calls };
}

function context(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["agent"], global: { json: false, yes: false, dryRun: false, ...global } };
}

function leaf(command: Command, path: string[]) {
  let node: Command | undefined = command;
  for (const segment of path) node = node?.children?.[segment];
  if (node?.run === undefined) throw new Error(`No such agent action: ${path.join(" ")}`);
  return node.run.bind(node);
}

describe("agent memory", () => {
  const MEMORIES = {
    total: 2,
    limit: 20,
    offset: 0,
    memories: [
      { id: "m-1", instanceId: "acme", content: "Prefers email", category: "preference", importance: 7, createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "m-2", instanceId: "acme", content: "Billing in EUR", category: "general", importance: 5, createdAt: "2026-08-02T00:00:00.000Z" },
    ],
  };

  // /memories is one of the routes that does NOT sit under /api, and it takes
  // the agent by slug in a query parameter rather than in the path.
  it("addresses the agent through the instanceId query parameter", async () => {
    const h = harness([response(MEMORIES)]);

    await leaf(h.command, ["memory", "list"])(["acme", "--search", "email", "--limit", "10"], context());

    expect(h.calls[0]).toMatchObject({
      path: "/memories",
      query: { instanceId: "acme", search: "email", limit: "10" },
    });
    expect(h.out.join("")).toMatch(/m-1\s+preference\s+7/);
  });

  it("refuses a limit that is not a positive integer", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["memory", "list"])(["acme", "--limit", "0"], context())).rejects.toThrow(/--limit/);
  });

  it("takes the content from a file or stdin, never a flag", async () => {
    const h = harness([response({ memory: { id: "m-3" } })], { readPayload: async () => "Prefers email\n" });

    await leaf(h.command, ["memory", "add"])(["acme", "--file", "-", "--category", "preference", "--importance", "7"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({
      method: "POST",
      path: "/memories",
      body: { instanceId: "acme", content: "Prefers email", category: "preference", importance: 7 },
    });
  });

  it("names the memory in the recap, and needs --confirm to delete one", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["memory", "remove"])(["acme", "m-1"], context({ yes: true }))).rejects.toThrow(/--confirm m-1/);
  });

  it("deletes one memory, carrying the agent in the query", async () => {
    const h = harness([response({ deleted: true })]);

    await leaf(h.command, ["memory", "remove"])(["acme", "m-1", "--confirm", "m-1"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ method: "DELETE", path: "/memories/m-1", query: { instanceId: "acme" } });
  });

  it("clears every memory only when the agent is named twice", async () => {
    const h = harness([response({ deleted: true })]);

    await expect(leaf(h.command, ["memory", "clear"])(["acme"], context({ yes: true }))).rejects.toThrow(/--confirm acme/);

    const second = harness([response({ deleted: true })]);
    await leaf(second.command, ["memory", "clear"])(["acme", "--confirm", "acme"], context({ yes: true }));
    expect(second.calls[0]).toMatchObject({ method: "DELETE", path: "/memories", query: { instanceId: "acme" } });
  });
});

describe("agent optouts", () => {
  const OPTOUTS = {
    optouts: [
      { channelType: "whatsapp", channelId: "+391234567890", status: "opted_out", source: "keyword", updatedAt: "2026-08-01T00:00:00.000Z" },
    ],
    page: 1,
  };

  it("lists the contacts currently opted out", async () => {
    const h = harness([response(OPTOUTS)]);

    await leaf(h.command, ["optouts", "list"])(["acme"], context());

    expect(h.calls[0]).toMatchObject({ path: "/api/instances/acme/optouts" });
    expect(h.out.join("")).toMatch(/whatsapp\s+\+391234567890\s+opted_out\s+keyword/);
  });

  it("passes the status filter through", async () => {
    const h = harness([response(OPTOUTS)]);

    await leaf(h.command, ["optouts", "list"])(["acme", "--status", "all", "--page", "2"], context());

    expect(h.calls[0]).toMatchObject({ query: { status: "all", page: "2" } });
  });

  it("refuses a status the engine does not know", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["optouts", "list"])(["acme", "--status", "unsubscribed"], context())).rejects.toThrow(
      /opted_out, opted_in, all/,
    );
  });

  it("opts a contact out as an administrator override", async () => {
    const h = harness([response({ ok: true })]);

    await leaf(h.command, ["optouts", "opt-out"])(["acme", "--channel", "whatsapp", "--contact", "+391234567890"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/instances/acme/optouts",
      body: { channelType: "whatsapp", channelId: "+391234567890" },
    });
  });

  // Opting a contact back IN resumes messaging someone who asked to stop, so it
  // names the contact twice like any other destructive act.
  it("needs the contact confirmed before opting it back in", async () => {
    const h = harness([]);

    await expect(
      leaf(h.command, ["optouts", "opt-in"])(["acme", "--channel", "whatsapp", "--contact", "+391234567890"], context({ yes: true })),
    ).rejects.toThrow(/--confirm \+391234567890/);
  });

  it("opts a contact back in once confirmed", async () => {
    const h = harness([response({ ok: true })]);

    await leaf(h.command, ["optouts", "opt-in"])(
      ["acme", "--channel", "whatsapp", "--contact", "+391234567890", "--confirm", "+391234567890"],
      context({ yes: true }),
    );

    expect(h.calls[0]).toMatchObject({
      method: "DELETE",
      path: "/api/instances/acme/optouts/whatsapp/%2B391234567890",
    });
  });
});
