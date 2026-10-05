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

const SCHEDULER = { status: "ok", scheduler: { running: true, maxConcurrent: 3, inFlight: 1, freeSlots: 2, stuckRunning: 0 } };

describe("monitor status", () => {
  it("reports reachability and every agent's state", async () => {
    const h = harness([response({ status: "ok", service: "polyant" }), response(SCHEDULER), response(AGENTS)]);

    await action(h.monitor, "status")([], context());

    expect(h.calls.map((c) => c.path)).toEqual(["/health", "/health/scheduler", "/api/instances"]);
    expect(h.calls[2].workspaceSlug).toBe("ws-1");
    const text = h.out.join("");
    expect(text).toContain("health:");
    expect(text).toContain("ok (polyant)");
    expect(text).toContain("acme");
    expect(text).toContain("running (1/3 slots in use, 0 stuck)");
  });

  // /health keeps answering ok while no scheduled task runs; that is what the probe is for.
  it("fails with the difference code when the scheduler loop has stopped", async () => {
    const stopped = { status: "ok", scheduler: { running: false, maxConcurrent: 3, inFlight: 0, freeSlots: 3, stuckRunning: 0 } };
    const h = harness([response({ status: "ok", service: "polyant" }), response(stopped), response(AGENTS)]);

    await expect(action(h.monitor, "status")([], context())).rejects.toMatchObject({ code: ExitCode.Difference });
    expect(h.out.join("")).toContain("STOPPED");
  });

  it("warns about stuck runs and a full pool without failing on one reading", async () => {
    const busy = { status: "ok", scheduler: { running: true, maxConcurrent: 3, inFlight: 3, freeSlots: 0, stuckRunning: 2 } };
    const h = harness([response({ status: "ok", service: "polyant" }), response(busy), response(AGENTS)]);

    await action(h.monitor, "status")([], context());

    expect(h.err.join("")).toContain("2 scheduled run(s) have been running past the default deadline");
    expect(h.err.join("")).toContain("no free slot");
  });

  it("reports an engine that does not serve the scheduler probe, and does not fail on it", async () => {
    const h = harness([
      response({ status: "ok", service: "polyant" }),
      new RemoteError("Cannot GET /health/scheduler", ExitCode.Config, 404),
      response(AGENTS),
    ]);

    await action(h.monitor, "status")([], context());

    expect(h.out.join("")).toContain("not served by this engine (older than 1.2.0)");
  });

  it("warns on stderr about an agent whose runtime routes need no token", async () => {
    const h = harness([response({ status: "ok", service: "polyant" }), response(SCHEDULER), response(AGENTS)]);

    await action(h.monitor, "status")([], context());

    expect(h.err.join("")).toContain('agent "open" has authEnabled=false');
    expect(h.err.join("")).not.toContain('"acme"');
  });

  it("labels an unavailable probe with its source error instead of a zero", async () => {
    const h = harness([
      new RemoteError("GET /health failed: connect ECONNREFUSED", ExitCode.Remote),
      new RemoteError("GET /health/scheduler failed: connect ECONNREFUSED", ExitCode.Remote),
      new RemoteError("Forbidden resource", ExitCode.Config, 403),
    ]);

    await expect(action(h.monitor, "status")([], context())).rejects.toThrow(/connect ECONNREFUSED/);

    const text = h.out.join("");
    expect(text).toContain("unavailable — GET /health failed: connect ECONNREFUSED");
    expect(text).toContain("agents: unavailable — Forbidden resource");
    expect(text).not.toContain("No agents in this workspace");
  });

  // Exiting 0 with a 403 in the output would make a CI health gate read a broken
  // permission as a healthy empty workspace.
  it("prints the whole report and then fails with the probe's own exit code", async () => {
    const h = harness([
      response({ status: "ok", service: "polyant" }),
      response(SCHEDULER),
      new RemoteError("Invalid management API key", ExitCode.Config, 401),
    ]);

    const failure = action(h.monitor, "status")([], context());
    await expect(failure).rejects.toMatchObject({ code: ExitCode.Config, status: 401 });
    expect(h.out.join("")).toContain("ok (polyant)");
  });

  it("emits every probe body unchanged as a composite object", async () => {
    const health = { status: "ok", service: "polyant" };
    const h = harness([response(health), response(SCHEDULER), response(AGENTS)]);

    await action(h.monitor, "status")([], context({ json: true }));

    expect(h.out.join("")).toBe(
      `{"health":${JSON.stringify(health)},"scheduler":${JSON.stringify(SCHEDULER)},"instances":${JSON.stringify(AGENTS)}}\n`,
    );
  });

  it("still emits the composite JSON before failing on a degraded probe", async () => {
    const health = { status: "ok", service: "polyant" };
    const h = harness([response(health), response(SCHEDULER), new RemoteError("Forbidden resource", ExitCode.Config, 403)]);

    await expect(action(h.monitor, "status")([], context({ json: true }))).rejects.toThrow(/Forbidden resource/);
    // A bare 403 cannot be told from a missing permission, so the workspace that
    // was actually sent is named alongside it.
    expect(h.out.join("")).toContain("was sent as x-workspace-slug");

    // stdout stays parseable so a pipeline can read the report and the exit code.
    const composite = JSON.parse(h.out.join("")) as { health: unknown; instances: { unavailable: string } };
    expect(composite.health).toMatchObject(health);
    expect(composite.instances.unavailable).toContain("Forbidden resource");
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
      workspaceSlug: "ws-1",
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

  it("narrows to one conversation, which is what lines a turn up with its traces", async () => {
    const h = harness([response({ items: [], total: 0, limit: 50, offset: 0 })]);

    await action(h.monitor, "events")(["--conversation", "conv-1"], context());

    expect(h.calls[0]).toMatchObject({ path: "/api/audit-logs", query: { conversationId: "conv-1" } });
  });

  it("names the conversation each event belongs to", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "events")([], context());

    const text = h.out.join("");
    expect(text).toContain("CONVERSATION");
    expect(text).toContain("conv-1");
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
      workspaceSlug: "ws-1",
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

describe("monitor ai-logs", () => {
  const page = {
    items: [
      {
        id: "log-1",
        provider: "anthropic",
        model: "claude-sonnet-4",
        tier: "standard",
        promptTokens: 500,
        completionTokens: 120,
        totalTokens: 620,
        cachedInputTokens: 0,
        estimatedCostUsd: 0.0123,
        durationMs: 890,
        conversationId: "conv-1",
        instanceId: "acme",
        callType: "conversation",
        outcome: "ok",
        errorKind: null,
        createdAt: "2026-07-29T10:00:00.000Z",
      },
    ],
    total: 42,
    limit: 10,
    offset: 0,
  };

  it("requests the raw route with its filters", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "ai-logs")(["--instance", "acme", "--call-type", "conversation", "--limit", "10"], context());

    expect(h.calls[0]).toMatchObject({
      path: "/api/ai-logs",
      query: { instanceId: "acme", callType: "conversation", limit: "10" },
    });
  });

  it("rejects an unknown option instead of dropping it", async () => {
    const h = harness([]);

    await expect(action(h.monitor, "ai-logs")(["--nope", "x"], context())).rejects.toMatchObject({ code: ExitCode.Config });
  });

  it("rejects a non-positive --limit before any request", async () => {
    const h = harness([]);

    await expect(action(h.monitor, "ai-logs")(["--limit", "-5"], context())).rejects.toMatchObject({ code: ExitCode.Config });
    expect(h.calls).toHaveLength(0);
  });

  it("renders the cost and cache columns and reports the page size on stderr", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "ai-logs")([], context());

    const text = h.out.join("");
    expect(text).toContain("claude-sonnet-4");
    expect(text).toContain("conversation");
    expect(h.err.join("")).toContain("1 of 42 calls.");
    expect(h.err.join("")).toContain("analytics aggregate excludes them");
  });

  it("passes the response through unchanged with --json", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "ai-logs")([], context({ json: true }));

    expect(h.out.join("")).toBe(JSON.stringify(page));
  });

  // The engine counts over at most 10001 rows and says so. Printing that total
  // bare would state a number it never measured.
  it("reports a capped total as a floor, not as the row count", async () => {
    const h = harness([response({ ...page, total: 10001, totalIsCapped: true })]);

    await action(h.monitor, "ai-logs")([], context());

    expect(h.err.join("")).toContain("1 of at least 10001 calls.");
  });

  it("reports an uncapped total plainly", async () => {
    const h = harness([response({ ...page, totalIsCapped: false })]);

    await action(h.monitor, "ai-logs")([], context());

    expect(h.err.join("")).toContain("1 of 42 calls.");
  });

  // An engine that predates the field never capped, so absent must not read as
  // "capped" — that would put "at least" in front of an exact number.
  it("treats an absent totalIsCapped as not capped", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "ai-logs")([], context());

    expect(h.err.join("")).not.toContain("at least");
  });
});

describe("monitor traces", () => {
  const page = {
    items: [
      {
        id: "trace-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        instanceId: "acme",
        channel: "whatsapp",
        contextPrepMs: 12,
        governanceInputMs: 3,
        toolBuildingMs: 5,
        llmCallMs: 720,
        governanceOutputMs: 4,
        totalMs: 890,
        ttfbMs: 210,
        promptTokens: 500,
        completionTokens: 120,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        model: "claude-sonnet-4",
        provider: "anthropic",
        cost: 0.0123,
        thinking: false,
        temperature: 0.7,
        toolCalls: 0,
        isStreaming: true,
        sttDurationMs: null,
        sttProvider: null,
        audioDurationSec: null,
        parentConversationId: null,
        parentTraceId: null,
        createdAt: "2026-07-29T10:00:00.000Z",
      },
    ],
    total: 17,
    limit: 5,
    offset: 0,
  };

  it("requests the trace route for one conversation", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "traces")(["--conversation", "acme:whatsapp:+39", "--limit", "5"], context());

    expect(h.calls[0]).toMatchObject({
      path: "/api/pipeline-traces",
      query: { conversationId: "acme:whatsapp:+39", limit: "5" },
    });
  });

  it("rejects an unknown option instead of dropping it", async () => {
    const h = harness([]);

    await expect(action(h.monitor, "traces")(["--nope", "x"], context())).rejects.toMatchObject({ code: ExitCode.Config });
  });

  it("rejects a non-positive --limit before any request", async () => {
    const h = harness([]);

    await expect(action(h.monitor, "traces")(["--limit", "-5"], context())).rejects.toMatchObject({ code: ExitCode.Config });
    expect(h.calls).toHaveLength(0);
  });

  it("renders the phase timings and reports the page size on stderr", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "traces")([], context());

    const text = h.out.join("");
    expect(text).toContain("claude-sonnet-4");
    expect(text).toContain("whatsapp");
    expect(h.err.join("")).toContain("1 of 17 turns.");
  });

  it("passes the response through unchanged with --json", async () => {
    const h = harness([response(page)]);

    await action(h.monitor, "traces")([], context({ json: true }));

    expect(h.out.join("")).toBe(JSON.stringify(page));
  });

  it("reports a capped total as a floor", async () => {
    const h = harness([response({ ...page, total: 10001, totalIsCapped: true })]);

    await action(h.monitor, "traces")([], context());

    expect(h.err.join("")).toContain("1 of at least 10001 turns.");
  });
});

describe("monitor scope", () => {
  // Monitoring is read-only, and a management key cannot discover its workspaces,
  // so it falls back to the engine's default resolution and says so.
  it("reads the default workspace and says so when none is selected", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const calls: RequestOptions[] = [];
    const queue = [response({ status: "ok", service: "polyant" }), response(SCHEDULER), response(AGENTS)];
    const monitor = createMonitorCommand({
      request: async (_target, opts) => {
        calls.push(opts);
        return queue.shift()!;
      },
      loadConfig: async () => ({ default: "dev", targets: CONFIG.targets }),
      env: ENV,
      io: {
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        input: { isTTY: false, readLine: async () => "" },
      },
    });
    const child = monitor.command.children?.status;
    if (child?.run === undefined) throw new Error("missing status action");

    await child.run([], context());

    expect(calls.every((c) => c.workspaceSlug === undefined)).toBe(true);
    expect(err.join("")).toContain("no workspace selected");
    expect(out.join("")).toContain("ok (polyant)");
  });
});
