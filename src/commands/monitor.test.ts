// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions, StreamEvent, StreamResponse } from "../api/client.js";
import type { CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import { ExitCode, RemoteError } from "../exit.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import type { ServiceDependencies } from "../runtime/service.js";
import { createMonitorCommand } from "./monitor.js";

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

async function* eventsOf(payloads: string[]): AsyncGenerator<StreamEvent> {
  for (const data of payloads) yield { data };
}

interface Harness {
  monitor: ReturnType<typeof createMonitorCommand>;
  out: string[];
  err: string[];
  calls: RequestOptions[];
  streamCalls: RequestOptions[];
}

function harness(
  responses: (ApiResponse | Error)[],
  options: { stream?: string[] | Error } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RequestOptions[] = [];
  const streamCalls: RequestOptions[] = [];
  const queue = [...responses];

  const deps: Partial<ServiceDependencies> = {
    request: async (_target, opts) => {
      calls.push(opts);
      const next = queue.shift();
      if (next === undefined) throw new Error(`Unexpected request: ${opts.method ?? "GET"} ${opts.path}`);
      if (next instanceof Error) throw next;
      return next;
    },
    requestStream: async (_target, opts): Promise<StreamResponse> => {
      streamCalls.push(opts);
      if (options.stream instanceof Error) throw options.stream;
      return { status: 200, events: eventsOf(options.stream ?? []) };
    },
    loadConfig: async () => CONFIG,
    env: ENV,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
  };

  return { monitor: createMonitorCommand(deps), out, err, calls, streamCalls };
}

function context(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["monitor"], global: { json: false, yes: false, dryRun: false, ...global } };
}

function action(monitor: Harness["monitor"], name: string) {
  const child = monitor.command.children?.[name];
  if (child?.run === undefined) throw new Error(`No such monitor action: ${name}`);
  return child.run.bind(child);
}

const AGENTS = {
  instances: [
    { slug: "acme", status: "active", authEnabled: true, provider: "anthropic", model: "claude-sonnet-4" },
    { slug: "open", status: "active", authEnabled: false, provider: "openai", model: "gpt-5" },
  ],
};

describe("monitor status", () => {
  it("reports reachability and every agent's state", async () => {
    const h = harness([response({ status: "ok", service: "polyant" }), response(AGENTS)]);

    await action(h.monitor, "status")([], context());

    expect(h.calls.map((c) => c.path)).toEqual(["/health", "/api/instances"]);
    expect(h.calls[1].workspaceId).toBe("ws-1");
    const text = h.out.join("");
    expect(text).toContain("health:");
    expect(text).toContain("ok (polyant)");
    expect(text).toContain("acme");
  });

  it("warns on stderr about an agent whose runtime routes need no token", async () => {
    const h = harness([response({ status: "ok", service: "polyant" }), response(AGENTS)]);

    await action(h.monitor, "status")([], context());

    expect(h.err.join("")).toContain('agent "open" has authEnabled=false');
    expect(h.err.join("")).not.toContain('"acme"');
  });

  it("labels an unavailable probe with its source error instead of a zero", async () => {
    const h = harness([
      new RemoteError("GET /health failed: connect ECONNREFUSED", ExitCode.Remote),
      new RemoteError("Forbidden resource", ExitCode.Config, 403),
    ]);

    await action(h.monitor, "status")([], context());

    const text = h.out.join("");
    expect(text).toContain("unavailable — GET /health failed: connect ECONNREFUSED");
    expect(text).toContain("agents: unavailable — Forbidden resource");
    expect(text).not.toContain("No agents in this workspace");
  });

  it("emits both probe bodies unchanged as a composite object", async () => {
    const health = { status: "ok", service: "polyant" };
    const h = harness([response(health), response(AGENTS)]);

    await action(h.monitor, "status")([], context({ json: true }));

    expect(h.out.join("")).toBe(`{"health":${JSON.stringify(health)},"instances":${JSON.stringify(AGENTS)}}\n`);
  });
});

describe("monitor events", () => {
  const page = {
    items: [
      {
        id: "a1",
        instanceId: "acme",
        conversationId: "conv-1",
        toolName: "web_search",
        action: "call",
        success: false,
        error: "upstream 502\nretried",
        durationMs: 812,
        createdAt: "2026-07-29T10:00:00.000Z",
      },
    ],
    total: 37,
    limit: 50,
    offset: 0,
  };

  it("serialises every filter into the query and reports the page size", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "events")(
      ["--instance", "acme", "--tool", "web_search", "--action", "call", "--search", "502", "--from", "2026-07-01", "--to", "2026-07-29", "--limit", "50", "--offset", "0"],
      context(),
    );

    expect(h.calls[0]).toMatchObject({
      path: "/api/audit-logs",
      workspaceId: "ws-1",
      query: {
        instanceId: "acme",
        toolName: "web_search",
        action: "call",
        search: "502",
        from: "2026-07-01",
        to: "2026-07-29",
        limit: "50",
        offset: "0",
      },
    });
    expect(h.out.join("")).toContain("web_search");
    // A multi-line error must not break the table's columns.
    expect(h.out.join("")).toContain("upstream 502 retried");
    expect(h.err.join("")).toContain("1 of 37 events.");
  });

  it("rejects a non-positive --limit before any request", async () => {
    const h = harness([]);

    await expect(action(h.monitor, "events")(["--limit", "-5"], context())).rejects.toThrow(/--limit needs a positive integer/);
  });

  it("rejects an unknown filter instead of sending it", async () => {
    const h = harness([]);

    await expect(action(h.monitor, "events")(["--agent", "acme"], context())).rejects.toThrow(/Unknown monitor events option --agent/);
  });

  it("passes the audit page through unchanged with --json", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "events")([], context({ json: true }));

    expect(h.out.join("")).toBe(JSON.stringify(page));
  });
});

describe("monitor events --follow", () => {
  const feed = [
    JSON.stringify({ id: "e1", ts: "2026-07-29T10:00:00.000Z", persona: "agent", text: "called a tool", instance: { slug: "acme", name: "Acme" }, tool: { name: "web_search", summary: "q=x" }, status: "success" }),
    JSON.stringify({ id: "e2", ts: "2026-07-29T10:00:01.000Z", persona: "thinking", text: "line one\nline two", instance: { slug: "acme", name: "Acme" }, category: "thinking" }),
  ];

  it("filters server-side, disables the deadline and renders each event on one line", async () => {
    const h = harness([], { stream: feed });

    await action(h.monitor, "events")(["--follow", "--instance", "acme", "--max", "2"], context());

    expect(h.streamCalls[0]).toMatchObject({
      path: "/api/activity-stream/live",
      query: { instance: "acme" },
      workspaceId: "ws-1",
      timeoutMs: 0,
    });
    const lines = h.out.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("tool=web_search");
    expect(lines[1]).toContain("line one line two");
  });

  it("emits JSON Lines of the original payloads with --json", async () => {
    const h = harness([], { stream: feed });

    await action(h.monitor, "events")(["--follow", "--max", "2"], context({ json: true }));

    expect(h.out.join("")).toBe(`${feed[0]}\n${feed[1]}\n`);
  });

  it("stops after --max events even when the stream continues", async () => {
    const h = harness([], { stream: [...feed, ...feed] });

    await action(h.monitor, "events")(["--follow", "--max", "1"], context({ json: true }));

    expect(h.out.join("")).toBe(`${feed[0]}\n`);
  });

  it("prints a frame the engine did not shape as JSON rather than dropping it", async () => {
    const h = harness([], { stream: ["not json at all"] });

    await action(h.monitor, "events")(["--follow", "--max", "1"], context());

    expect(h.out.join("")).toBe("not json at all\n");
  });

  it("surfaces a refused subscription as a remote failure", async () => {
    const h = harness([], { stream: new RemoteError("Too many concurrent activity-stream subscribers", ExitCode.Remote, 503) });

    await expect(action(h.monitor, "events")(["--follow"], context())).rejects.toThrow(/Too many concurrent/);
  });
});

describe("monitor stats", () => {
  it("summarises totals and per-tool counts", async () => {
    const h = harness([
      response({ totalEntries: 120, errorCount: 3, errorRate: 0.025, byTool: [{ toolName: "web_search", count: 90 }], byAction: [] }),
    ]);

    await action(h.monitor, "stats")(["--instance", "acme"], context());

    expect(h.calls[0]).toMatchObject({ path: "/api/audit-logs/stats", query: { instanceId: "acme" } });
    const text = h.out.join("");
    expect(text).toContain("totalEntries:");
    expect(text).toContain("web_search");
  });

  it("refuses a response that carries no statistics", async () => {
    const h = harness([response({})]);

    await expect(action(h.monitor, "stats")([], context())).rejects.toThrow(/did not return statistics/);
  });
});

describe("monitor events as agent logs", () => {
  it("forces the instance filter and ignores a conflicting --instance flag", async () => {
    const h = harness([response({ items: [], total: 0, limit: 50, offset: 0 })]);

    await h.monitor.actions.events(["acme", "--instance", "beta"], context(), "acme");

    expect(h.calls[0].query).toMatchObject({ instanceId: "acme" });
  });

  it("keeps the forced filter on the live stream too", async () => {
    const h = harness([], { stream: [] });

    await h.monitor.actions.events(["acme", "--follow"], context(), "acme");

    expect(h.streamCalls[0].query).toMatchObject({ instance: "acme" });
  });
});

describe("monitor scope", () => {
  it("refuses to run when no context or flag selects a workspace", async () => {
    const request = vi.fn();
    const monitor = createMonitorCommand({
      request,
      loadConfig: async () => ({ default: "dev", targets: CONFIG.targets }),
      env: ENV,
      io: { stdout: () => {}, stderr: () => {}, input: { isTTY: false, readLine: async () => "" } },
    });
    const child = monitor.command.children?.status;
    if (child?.run === undefined) throw new Error("missing status action");

    await expect(child.run([], context())).rejects.toThrow(/Missing required scope component/);
    expect(request).not.toHaveBeenCalled();
  });
});
