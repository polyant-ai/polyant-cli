// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import type { ServiceDependencies } from "../runtime/service.js";
import { createAnalyticsCommand } from "./analytics.js";

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" } },
  contexts: { dev: { target: "dev", org: "acme", workspace: "ws-1" } },
  defaultContext: "dev",
};

const ENV = { POLYANT_KEY_DEV: "pk_dev_secret" };

const OVERVIEW = {
  overview: {
    totalCost: 12.5,
    totalTokens: 900000,
    promptTokens: 700000,
    completionTokens: 200000,
    cachedInputTokens: 120000,
    totalConversations: 340,
    totalMessages: 1800,
    uniqueUsers: 96,
    avgCostPerConversation: 0.037,
    avgResponseTime: 2400,
  },
  dailyTrend: [{ date: "2026-07-28", cost: 1.2, tokens: 80000, conversations: 30, messages: 150 }],
  channelDistribution: [{ channel: "telegram", conversations: 200, messages: 900 }],
  modelDistribution: [{ provider: "anthropic", model: "claude-sonnet-4", calls: 500, tokens: 700000, cost: 9.1, avgDuration: 2100 }],
  toolUsage: [{ tool: "web_search", count: 210 }],
  instanceComparison: [{ instanceId: "acme", name: "Acme", conversations: 340, cost: 12.5, tokens: 900000 }],
  latency: {
    overview: { p50: 1800, p95: 4200, p99: 8100, avgTotal: 2400, avgTtfb: 600, sampleCount: 480 },
    slowestTools: [{ tool: "web_search", avgDurationMs: 900, callCount: 210, p95: 1900, successRate: 0.98 }],
  },
};

function response(body: unknown): ApiResponse {
  return { status: 200, raw: JSON.stringify(body), body };
}

function harness(responses: ApiResponse[]) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RequestOptions[] = [];
  const queue = [...responses];
  const deps: Partial<ServiceDependencies> = {
    request: async (_target, opts) => {
      calls.push(opts);
      const next = queue.shift();
      if (next === undefined) throw new Error(`Unexpected request: ${opts.path}`);
      return next;
    },
    loadConfig: async () => CONFIG,
    env: ENV,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
  };
  return { command: createAnalyticsCommand(deps), out, err, calls };
}

function context(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["analytics"], global: { json: false, yes: false, dryRun: false, ...global } };
}

function action(command: ReturnType<typeof createAnalyticsCommand>, name: string) {
  const child = command.children?.[name];
  if (child?.run === undefined) throw new Error(`No such analytics action: ${name}`);
  return child.run.bind(child);
}

describe("analytics overview", () => {
  it("serialises the range and sends the workspace header", async () => {
    const h = harness([response(OVERVIEW)]);

    await action(h.command, "overview")(["--from", "2026-07-01", "--to", "2026-07-29"], context());

    expect(h.calls[0]).toMatchObject({
      path: "/api/analytics",
      workspaceId: "ws-1",
      query: { from: "2026-07-01", to: "2026-07-29" },
    });
  });

  it("reports the overview, the daily trend, the models and the per-agent comparison", async () => {
    const h = harness([response(OVERVIEW)]);

    await action(h.command, "overview")([], context());

    const text = h.out.join("");
    expect(text).toContain("conversations:");
    expect(text).toContain("latency p50/p95/p99");
    expect(text).toContain("1800 / 4200 / 8100");
    expect(text).toContain("2026-07-28");
    expect(text).toContain("claude-sonnet-4");
    expect(text).toContain("Acme");
  });

  it("labels missing latency as unavailable rather than as zero", async () => {
    const { latency: _dropped, ...withoutLatency } = OVERVIEW;
    const h = harness([response(withoutLatency)]);

    await action(h.command, "overview")([], context());

    const text = h.out.join("");
    expect(text).toMatch(/latency p50\/p95\/p99: +unavailable/);
    expect(text).toMatch(/latency samples: +unavailable/);
    expect(text).not.toContain("0 / 0 / 0");
  });

  it("names the empty range instead of rendering a bare table", async () => {
    const h = harness([response({ overview: OVERVIEW.overview, latency: OVERVIEW.latency })]);

    await action(h.command, "overview")([], context());

    const text = h.out.join("");
    expect(text).toContain("No daily activity in this range.");
    expect(text).toContain("No model calls in this range.");
    expect(text).toContain("No per-agent comparison in this range.");
  });

  it("passes the response body through unchanged with --json", async () => {
    const h = harness([response(OVERVIEW)]);

    await action(h.command, "overview")([], context({ json: true }));

    expect(h.out.join("")).toBe(JSON.stringify(OVERVIEW));
  });

  it("refuses a response that carries no overview", async () => {
    const h = harness([response({ dailyTrend: [] })]);

    await expect(action(h.command, "overview")([], context())).rejects.toThrow(/did not return an overview/);
  });
});

describe("analytics agent", () => {
  it("reads the per-agent route and reports the slowest tools", async () => {
    const h = harness([response(OVERVIEW)]);

    await action(h.command, "agent")(["acme", "--from", "2026-07-01"], context());

    expect(h.calls[0]).toMatchObject({ path: "/api/instances/acme/analytics", query: { from: "2026-07-01" } });
    expect(h.out.join("")).toContain("SUCCESS RATE");
    expect(h.out.join("")).toContain("web_search");
  });

  it("requires an agent slug", async () => {
    const h = harness([]);

    await expect(action(h.command, "agent")([], context())).rejects.toThrow(/needs an agent slug/);
  });

  it("rejects an unknown option instead of sending it", async () => {
    const h = harness([]);

    await expect(action(h.command, "agent")(["acme", "--range", "7d"], context()))
      .rejects.toThrow(/Unknown analytics agent option --range/);
  });
});
