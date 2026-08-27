// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
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

function payload(text: string): Partial<AgentCommandDependencies> {
  return { readPayload: async () => text };
}

describe("agent mcp", () => {
  const SERVERS = [
    { slug: "github", name: "GitHub", url: "https://mcp.example/github", authMode: "static", enabled: true, config: { auth: { type: "bearer", token: "••••" } } },
    { slug: "docs", name: "Docs", url: "https://mcp.example/docs", authMode: "none", enabled: false, config: {} },
  ];

  it("lists the servers with their auth mode and config key names", async () => {
    const h = harness([response(SERVERS)]);

    await leaf(h.command, ["mcp", "show"])(["acme"], context());

    const table = h.out.join("");
    expect(h.calls[0]).toMatchObject({ path: "/api/instances/acme/mcp-servers" });
    expect(table).toMatch(/github\s+GitHub\s+https:\/\/mcp\.example\/github\s+static\s+yes\s+auth/);
    expect(table).toMatch(/docs\s+Docs\s+\S+\s+none\s+no/);
  });

  // The engine masks a stored token as "••••". Printing the masked value would
  // still disclose which fields are populated, so the table names the keys.
  it("never prints a config value, masked or not", async () => {
    const h = harness([response(SERVERS)]);

    await leaf(h.command, ["mcp", "show"])(["acme"], context());

    expect(h.out.join("")).not.toContain("••••");
  });

  it("sends the whole server definition, enabled unless --disable", async () => {
    const h = harness(
      [response({ ok: true })],
      payload(JSON.stringify({ name: "GitHub", url: "https://mcp.example/github", authMode: "static", config: { auth: { type: "bearer", token: "t" } } })),
    );

    await leaf(h.command, ["mcp", "set"])(["acme", "github", "--file", "-"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/instances/acme/mcp-servers/github",
      body: {
        name: "GitHub",
        url: "https://mcp.example/github",
        authMode: "static",
        enabled: true,
        config: { auth: { type: "bearer", token: "t" } },
      },
    });
  });

  it("recaps the key names and the URL, never the credential", async () => {
    const h = harness(
      [response({ ok: true })],
      payload(JSON.stringify({ name: "GitHub", url: "https://mcp.example/github", authMode: "static", config: { auth: { type: "bearer", token: "s3cret" } } })),
    );

    await leaf(h.command, ["mcp", "set"])(["acme", "github", "--file", "-", "--disable"], context({ yes: true }));

    const recap = h.err.join("");
    expect(recap).toContain("https://mcp.example/github");
    expect(recap).toContain("auth");
    expect(recap).not.toContain("s3cret");
    expect(h.calls[0]).toMatchObject({ body: { enabled: false } });
  });

  it("refuses an auth mode the engine does not have", async () => {
    const h = harness([], payload(JSON.stringify({ name: "n", url: "https://x.example", authMode: "basic", config: {} })));

    await expect(leaf(h.command, ["mcp", "set"])(["acme", "github", "--file", "-"], context({ yes: true }))).rejects.toThrow(
      /authMode must be one of none, static, oauth/,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a payload with no url", async () => {
    const h = harness([], payload(JSON.stringify({ name: "n", authMode: "none", config: {} })));

    await expect(leaf(h.command, ["mcp", "set"])(["acme", "github", "--file", "-"], context({ yes: true }))).rejects.toThrow(/url/);
  });

  it("needs --confirm to remove a server", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["mcp", "remove"])(["acme", "github"], context({ yes: true }))).rejects.toThrow(/--confirm github/);
    expect(h.calls).toHaveLength(0);
  });

  it("removes a server once confirmed", async () => {
    const h = harness([response({ deleted: true })]);

    await leaf(h.command, ["mcp", "remove"])(["acme", "github", "--confirm", "github"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ method: "DELETE", path: "/api/instances/acme/mcp-servers/github" });
  });

  // The probe writes nothing, so it asks for no confirmation — but it does dial
  // the URL, which is why it stays a command rather than a flag on `set`.
  it("dials a candidate without confirmation, naming the saved server to reuse its secret", async () => {
    const h = harness(
      [response({ ok: true, tools: ["search"] })],
      payload(JSON.stringify({ name: "GitHub", url: "https://mcp.example/github", authMode: "static", config: {} })),
    );

    await leaf(h.command, ["mcp", "test"])(["acme", "--file", "-", "--server", "github"], context());

    expect(h.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/instances/acme/mcp-servers/test",
      body: { slug: "github", name: "GitHub", url: "https://mcp.example/github", authMode: "static", enabled: true, config: {} },
    });
    expect(h.out.join("")).toContain("search");
  });
});

describe("agent a2a", () => {
  const AGENT = { instance: { slug: "acme", a2aEnabled: false, authEnabled: true } };

  it("reports whether the agent is exposed, and where", async () => {
    const h = harness([response({ instance: { slug: "acme", a2aEnabled: true, authEnabled: true } })]);

    await leaf(h.command, ["a2a", "show"])(["acme"], context());

    const report = h.out.join("");
    expect(report).toContain("yes");
    expect(report).toContain("http://localhost:4000/a2a/acme/.well-known/agent-card.json");
    expect(report).toContain("http://localhost:4000/a2a/acme/jsonrpc");
  });

  it("enables the protocol with a PATCH", async () => {
    const h = harness([response(AGENT), response({ ok: true })]);

    await leaf(h.command, ["a2a", "enable"])(["acme"], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "PATCH", path: "/api/instances/acme", body: { a2aEnabled: true } });
  });

  // The agent card is served unauthenticated whenever A2A is on, and the
  // JSON-RPC endpoint is only as closed as the agent's own auth switch.
  it("warns that an agent with authentication off is exposed to anyone", async () => {
    const h = harness([response({ instance: { slug: "acme", a2aEnabled: false, authEnabled: false } }), response({ ok: true })]);

    await leaf(h.command, ["a2a", "enable"])(["acme"], context({ yes: true }));

    expect(h.err.join("")).toMatch(/authEnabled is false/);
  });

  it("disables the protocol with a PATCH", async () => {
    const h = harness([response({ instance: { slug: "acme", a2aEnabled: true, authEnabled: true } }), response({ ok: true })]);

    await leaf(h.command, ["a2a", "disable"])(["acme"], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "PATCH", path: "/api/instances/acme", body: { a2aEnabled: false } });
  });

  it("fetches the agent card from the public discovery route", async () => {
    const h = harness([response({ name: "acme", version: "1.0.0" })]);

    await leaf(h.command, ["a2a", "card"])(["acme"], context());

    expect(h.calls[0]).toMatchObject({ path: "/a2a/acme/.well-known/agent-card.json" });
    expect(h.out.join("")).toContain('"version":"1.0.0"');
  });
});
