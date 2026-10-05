// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import { CliError, ExitCode } from "../exit.js";
import { createAnalyticsCommand } from "./analytics.js";
import { createAgentCommand, type AgentCommandDependencies } from "./agent.js";

/** The supervision checks, and the shared-knowledge switch, on the agent family. */

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
  const deps = {
    request: request as unknown as AgentCommandDependencies["request"],
    loadConfig: async () => CONFIG,
    env: { POLYANT_KEY_DEV: "pk_dev_secret" },
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
    ...overrides,
  };
  return { agent: createAgentCommand(deps), analytics: createAnalyticsCommand(deps), out, err, calls };
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

const CHECKS = {
  instanceId: "acme",
  name: "Acme",
  checks: [
    {
      id: "tools-failing",
      severity: "broken",
      titleKey: "status.check.toolsFailing.title",
      bodyKey: "status.check.toolsFailing.body",
      params: { names: "search (12/40)" },
      section: "tools",
      sectionKey: "status.section.tools",
    },
  ],
  dismissed: [
    {
      id: "hooks-orphaned",
      severity: "warning",
      titleKey: "x",
      bodyKey: "y",
      section: "hooks",
      sectionKey: "z",
    },
  ],
  tally: { broken: 1, warning: 0 },
};

describe("agent checks", () => {
  // The engine serves i18n keys, not sentences, so the ID and the measurement
  // are what the CLI can honestly print.
  it("prints the check id, its severity and the numbers that raised it", async () => {
    const h = harness([response(CHECKS)]);

    await leaf(h.agent, ["checks", "show"])(["acme"], context());

    const text = h.out.join("");
    expect(text).toContain("tools-failing");
    expect(text).toContain("broken");
    expect(text).toContain("names=search (12/40)");
  });

  // A silence has to be visible: otherwise it is indistinguishable from a check
  // that never fired.
  it("lists the silenced checks apart from the live ones", async () => {
    const h = harness([response(CHECKS)]);

    await leaf(h.agent, ["checks", "show"])(["acme"], context());

    expect(h.out.join("")).toContain("Silenced on this agent:");
    expect(h.err.join("")).toContain("broken: 1");
  });

  it("says an agent that raised nothing raised nothing, rather than showing an empty table", async () => {
    const h = harness([response({ ...CHECKS, checks: [], dismissed: [], tally: { broken: 0, warning: 0 } })]);

    await leaf(h.agent, ["checks", "show"])(["acme"], context());

    expect(h.out.join("")).toContain("raised nothing in the window");
  });

  it("narrows the window with --days, and refuses a value that is not one", async () => {
    const h = harness([response(CHECKS)]);
    await leaf(h.agent, ["checks", "show"])(["acme", "--days", "30"], context());
    expect(h.calls[0]).toMatchObject({ path: "/api/instances/acme/checks", query: { days: "30" } });

    const bad = harness([]);
    await expect(leaf(bad.agent, ["checks", "show"])(["acme", "--days", "0"], context())).rejects.toThrow(/--days needs a positive integer/);
  });

  it("sends a dismissal note as a body, and says the silence reaches every tier", async () => {
    const h = harness([response({ dismissed: true })]);

    await leaf(h.agent, ["checks", "dismiss"])(["acme", "tools-failing", "--note", "known, fix planned"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/instances/acme/check-dismissals/tools-failing",
      body: { note: "known, fix planned" },
    });
    expect(h.err.join("")).toContain("workspace dashboard");
  });

  it("restores a check by deleting its dismissal", async () => {
    const h = harness([response({ restored: true })]);

    await leaf(h.agent, ["checks", "restore"])(["acme", "tools-failing"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ method: "DELETE", path: "/api/instances/acme/check-dismissals/tools-failing" });
  });
});

describe("agent checkup", () => {
  it("prints only live checks, then exits with the difference code", async () => {
    const h = harness([response(CHECKS)]);

    let error: unknown;
    try {
      await leaf(h.agent, ["checkup"])(["acme"], context());
    } catch (caught) {
      error = caught;
    }

    expect(h.calls[0]).toMatchObject({ path: "/api/instances/acme/checks", query: {} });
    expect(h.out.join("").split("\n")[0].replace(/\s+/g, " ").trim()).toBe(
      "SEVERITY CHECK SECTION PARAMS",
    );
    expect(h.out.join("")).toContain("tools-failing");
    expect(h.out.join("")).not.toContain("hooks-orphaned");
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ExitCode.Difference);
  });

  it("passes --days and rejects non-positive values", async () => {
    const h = harness([response({ ...CHECKS, checks: [] })]);
    await leaf(h.agent, ["checkup"])(["acme", "--days", "30"], context());
    expect(h.calls[0].query).toEqual({ days: "30" });

    const bad = harness([]);
    await expect(leaf(bad.agent, ["checkup"])(["acme", "--days", "0"], context()))
      .rejects.toThrow(/--days needs a positive integer/);
  });

  it("forwards the raw DTO in JSON mode before exiting with a difference", async () => {
    const h = harness([response(CHECKS)]);

    await expect(leaf(h.agent, ["checkup"])(["acme"], context({ json: true })))
      .rejects.toMatchObject({ code: ExitCode.Difference });
    expect(h.out.join("")).toBe(JSON.stringify(CHECKS));
  });

  it("lists a note but does not fail on it unless --fail-on note asks", async () => {
    const note = { ...CHECKS.checks[0], id: "budget-unset", severity: "note", section: "cost" };
    const h = harness([response({ ...CHECKS, checks: [note] })]);

    await leaf(h.agent, ["checkup"])(["acme"], context());
    expect(h.out.join("")).toContain("budget-unset");

    const strict = harness([response({ ...CHECKS, checks: [note] })]);
    await expect(leaf(strict.agent, ["checkup"])(["acme", "--fail-on", "note"], context()))
      .rejects.toMatchObject({ code: ExitCode.Difference });
  });

  it("--fail-on broken lets a warning through and still fails on broken", async () => {
    const warning = { ...CHECKS.checks[0], id: "no-retention", severity: "warning" };
    const h = harness([response({ ...CHECKS, checks: [warning] })]);
    await leaf(h.agent, ["checkup"])(["acme", "--fail-on", "broken"], context());

    const broken = harness([response(CHECKS)]);
    await expect(leaf(broken.agent, ["checkup"])(["acme", "--fail-on", "broken"], context()))
      .rejects.toThrow(/1 active check\(s\) at broken or above/);
  });

  it("fails on a severity it does not know, rather than passing it", async () => {
    const h = harness([response({ ...CHECKS, checks: [{ ...CHECKS.checks[0], severity: "critical" }] })]);

    await expect(leaf(h.agent, ["checkup"])(["acme"], context())).rejects.toMatchObject({ code: ExitCode.Difference });
  });

  it("rejects an unknown --fail-on before asking the engine", async () => {
    const h = harness([]);

    await expect(leaf(h.agent, ["checkup"])(["acme", "--fail-on", "fatal"], context())).rejects.toThrow(
      /--fail-on must be one of broken, warning, note/,
    );
    expect(h.calls).toEqual([]);
  });

  it("returns cleanly when there are no live checks", async () => {
    const h = harness([response({ ...CHECKS, checks: [], dismissed: CHECKS.dismissed })]);

    await leaf(h.agent, ["checkup"])(["acme"], context());

    expect(h.out.join("")).toContain("No active checks for agent acme.");
  });
});

describe("agent health", () => {
  it("keeps the unevaluated gates apart from the blocked turns", async () => {
    const h = harness([
      response({
        windowDays: 7,
        tools: [{ name: "search", calls: 40, failures: 12 }],
        hooks: [{ name: "after", runs: 3, failures: 0 }],
        governanceBlocks: 2,
        governanceUnevaluated: 5,
        llmCalls: 100,
        llmFailures: 1,
      }),
    ]);

    await leaf(h.agent, ["health"])(["acme"], context());

    const text = h.out.join("");
    expect(text).toContain("tool");
    expect(text).toContain("search");
    expect(text).toContain("governanceBlocks:       2");
    expect(text).toContain("governanceUnevaluated:  5");
  });
});

describe("analytics checks", () => {
  it("counts the same checks per agent, one tier up", async () => {
    const h = harness([response({ agents: [CHECKS] })]);

    await leaf(h.analytics, ["checks"])([], context());

    expect(h.calls[0].path).toBe("/api/analytics/agent-checks");
    expect(h.out.join("")).toContain("tools-failing");
  });
});

describe("agent shared-knowledge", () => {
  const SHARED = {
    documents: [
      { id: "d-1", filename: "handbook.pdf", mimeType: "application/pdf", sizeBytes: 10, status: "ready", chunkCount: 4, tier: "organization", enabled: true, usable: false },
    ],
    revoked: [{ documentId: "d-9", filename: "old.pdf" }],
    embedder: { provider: "openai", dimensions: 1536 },
    agentEmbedder: { provider: "nebius", dimensions: 1024 },
    embedderCredentialReady: false,
  };

  // Since 1.2.0 the query is embedded with the organisation's embedder, so the
  // agent's own no longer has to match; the credential is what can still fail.
  it("marks an unusable document, and says the agent's embedder covers its own knowledge only", async () => {
    const h = harness([response(SHARED)]);

    await leaf(h.agent, ["shared-knowledge", "show"])(["acme"], context());

    const text = h.out.join("");
    expect(text).toMatch(/handbook\.pdf\s+organization\s+ready\s+yes\s+no/);
    expect(text).toContain("library embedder:    openai (1536)");
    expect(text).toContain("library credential:  MISSING");
    expect(text).toContain("agent embedder:      nebius (1024) — own knowledge only");
  });

  it("reports a document that was switched on and later withdrawn", async () => {
    const h = harness([response(SHARED)]);

    await leaf(h.agent, ["shared-knowledge", "show"])(["acme"], context());

    expect(h.out.join("")).toContain("REVOKED DOCUMENT");
  });

  it("switches one on and off through the agent's own route", async () => {
    const on = harness([response({ enabled: true })]);
    await leaf(on.agent, ["shared-knowledge", "enable"])(["acme", "d-1"], context({ yes: true }));
    expect(on.calls[0]).toMatchObject({ method: "PUT", path: "/api/instances/acme/shared-knowledge/d-1" });

    const off = harness([response({ disabled: true })]);
    await leaf(off.agent, ["shared-knowledge", "disable"])(["acme", "d-1"], context({ yes: true }));
    expect(off.calls[0]).toMatchObject({ method: "DELETE", path: "/api/instances/acme/shared-knowledge/d-1" });
  });
});
