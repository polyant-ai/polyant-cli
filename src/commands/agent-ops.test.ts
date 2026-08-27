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

describe("agent skills", () => {
  const SKILLS = {
    skills: [
      { name: "triage", description: "d", enabled: true, autoLoad: false, envConfigured: false, currentVersion: "1.0.0", hasUpdate: true },
      { name: "billing", description: "d", enabled: false, autoLoad: false, envConfigured: true, currentVersion: null, hasUpdate: false },
    ],
  };

  it("shows which skills are on, and which want an upgrade", async () => {
    const h = harness([response(SKILLS)]);

    await leaf(h.command, ["skills", "show"])(["acme"], context());

    const table = h.out.join("");
    expect(table).toMatch(/triage\s+yes\s+no\s+1\.0\.0\s+yes\s+no/);
    expect(table).toMatch(/billing\s+no/);
  });

  // The engine REPLACES the selection, so an omitted skill is a disabled one.
  it("says the write replaces the selection, not adds to it", async () => {
    const h = harness([response({ skills: [], toolsChanged: false })]);

    await leaf(h.command, ["skills", "set"])(["acme", "--enable", "triage, billing"], context({ yes: true }));

    expect(h.err.join("")).toContain("Anything not listed is disabled");
    expect(h.calls[0]).toMatchObject({
      method: "PATCH",
      path: "/api/instances/acme/skills",
      body: { enabled: ["triage", "billing"] },
    });
  });

  it("sends an empty selection for --none", async () => {
    const h = harness([response({ skills: [] })]);

    await leaf(h.command, ["skills", "set"])(["acme", "--none"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ body: { enabled: [] } });
  });

  it("refuses both --enable and --none, and neither", async () => {
    for (const args of [["acme"], ["acme", "--none", "--enable", "triage"]]) {
      const h = harness([]);
      await expect(leaf(h.command, ["skills", "set"])(args, context({ yes: true }))).rejects.toThrow(
        /either --enable <name,name> or --none/,
      );
    }
  });

  it("requires --on or --off for autoload", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["skills", "autoload"])(["acme", "triage"], context({ yes: true }))).rejects.toThrow(
      /needs --on or --off/,
    );
  });

  it("points at the command that lists version ids when rolling back", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["skills", "rollback"])(["acme", "triage"], context({ yes: true }))).rejects.toThrow(
      /skill versions <name>/,
    );
  });

  it("keeps a skill env value out of the recap and out of stdout", async () => {
    const h = harness([response({ env: [] })], { readPayload: async () => "tok-secret\n" });

    await leaf(h.command, ["skills", "env", "set"])(
      ["acme", "triage", "--key", "ZENDESK_TOKEN", "--file", "t.txt", "--sensitive"],
      context({ yes: true }),
    );

    expect(h.err.join("")).toContain("10 characters from t.txt");
    expect(h.err.join("")).not.toContain("tok-secret");
    expect(h.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/instances/acme/skills/triage/env",
      body: { env: [{ key: "ZENDESK_TOKEN", value: "tok-secret", sensitive: true }] },
    });
  });
});

describe("agent knowledge", () => {
  it("shows a failed ingestion's reason next to its status", async () => {
    const h = harness([
      response({
        documents: [
          { id: "d-1", filename: "faq.md", status: "ready", chunkCount: 12, sizeBytes: 900, errorMessage: null, updatedAt: null },
          { id: "d-2", filename: "big.pdf", status: "error", chunkCount: null, sizeBytes: 1, errorMessage: "too large", updatedAt: null },
        ],
      }),
    ]);

    await leaf(h.command, ["knowledge", "list"])(["acme"], context());

    expect(h.out.join("")).toContain("error: too large");
  });

  it("defaults the filename to the file's own", async () => {
    const h = harness([response({ document: {} }, 201)], { readPayload: async () => "content" });

    await leaf(h.command, ["knowledge", "add"])(["acme", "--file", "docs/faq.md"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ body: { filename: "faq.md", content: "content" } });
  });

  it("needs a filename when the content comes from stdin", async () => {
    const h = harness([], { readPayload: async () => "content" });

    await expect(leaf(h.command, ["knowledge", "add"])(["acme", "--file", "-"], context({ yes: true }))).rejects.toThrow(
      /needs --filename/,
    );
  });
});

describe("agent tasks", () => {
  it("names the field the payload is missing", async () => {
    const h = harness([], { readPayload: async () => JSON.stringify({ name: "digest" }) });

    await expect(leaf(h.command, ["tasks", "create"])(["acme", "--file", "-"], context({ yes: true }))).rejects.toThrow(
      /needs a prompt/,
    );
  });

  it("warns that running a task now really delivers", async () => {
    const h = harness([response({ run: {} })]);

    await leaf(h.command, ["tasks", "run"])(["acme", "t-1"], context({ yes: true }));

    expect(h.err.join("")).toContain("delivers to its outbound channel");
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/instances/acme/scheduled-tasks/t-1/run" });
  });

  it("passes the paging and filter flags through as query", async () => {
    const h = harness([response({ runs: [] })]);

    await leaf(h.command, ["tasks", "runs"])(["acme", "--task", "t-1", "--status", "error", "--limit", "5"], context());

    expect(h.calls[0].query).toEqual({ limit: "5", taskId: "t-1", status: "error" });
  });
});

describe("agent events", () => {
  it("prints the create response whole, because it carries the only copy of the token", async () => {
    const h = harness([response({ source: { id: "s-1" }, token: "es_abc" }, 201)], {
      readPayload: async () => JSON.stringify({ name: "crm" }),
    });

    await leaf(h.command, ["events", "add"])(["acme", "--file", "-"], context({ yes: true }));

    expect(h.out.join("")).toContain("es_abc");
  });

  it("warns that rotating breaks every current producer", async () => {
    const h = harness([response({ token: "es_new" })]);

    await leaf(h.command, ["events", "rotate"])(["acme", "s-1", "--confirm", "s-1"], context({ yes: true }));

    expect(h.err.join("")).toContain("Update every producer before rotating");
  });

  // Since 1.1.0 the list is a DTO that deliberately omits the token, so the URL
  // has one route of its own and the CLI needs a command for it.
  it("reveals one source's ingest URL through the dedicated route", async () => {
    const h = harness([response({ webhookUrl: "http://localhost:4000/webhooks/es_abc" })]);

    await leaf(h.command, ["events", "url"])(["acme", "s-1"], context());

    expect(h.calls[0]).toMatchObject({ path: "/api/instances/acme/event-sources/s-1/webhook-url" });
    expect(h.out.join("")).toContain("es_abc");
  });

  it("reads definitions without --file and writes with it", async () => {
    const read = harness([response({ definitions: [] })]);
    await leaf(read.command, ["events", "definitions"])(["acme", "s-1"], context());
    expect(read.calls[0].method).toBeUndefined();

    const write = harness([response({ definition: {} }, 201)], { readPayload: async () => JSON.stringify({ name: "d" }) });
    await leaf(write.command, ["events", "definitions"])(["acme", "s-1", "--file", "-"], context({ yes: true }));
    expect(write.calls[0].method).toBe("POST");
  });
});

describe("agent retention", () => {
  // "No policy" is not "keep nothing" — the deployment default still applies.
  it("says the deployment default applies when there is no policy", async () => {
    const h = harness([response({ policy: null, defaultDays: 90 })]);

    await leaf(h.command, ["retention", "show"])(["acme"], context());

    expect(h.out.join("")).toContain("no retention policy. The deployment default of 90 days applies");
  });

  it("names the field a retention payload is missing", async () => {
    const h = harness([], { readPayload: async () => JSON.stringify({ enabled: true, schedule: {}, retentionDays: 30 }) });

    await expect(leaf(h.command, ["retention", "set"])(["acme", "--file", "-"], context({ yes: true }))).rejects.toThrow(
      /needs a preserveGovernance/,
    );
  });

  // --count-only is the ENGINE's dry run; --dry-run is the CLI's.
  it("asks the engine to count instead of delete under --count-only, without needing --confirm", async () => {
    const h = harness([response({ dryRun: true, conversationsScanned: 4 })]);

    await leaf(h.command, ["retention", "run"])(["acme", "--count-only"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/instances/acme/retention/run", body: { dryRun: true } });
  });

  it("requires a matching --confirm for a real purge", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["retention", "run"])(["acme"], context({ yes: true }))).rejects.toThrow(
      /--confirm acme is required/,
    );
  });
});

describe("agent import", () => {
  // Same body, opposite blast radius, told apart by whether a slug is named.
  it("creates in the addressed workspace when no slug is named", async () => {
    const h = harness([response({ instance: {} }, 201)], { readPayload: async () => JSON.stringify({ version: 1 }) });

    await leaf(h.command, ["import"])(["--file", "-"], context({ yes: true }));

    expect(h.calls[0].path).toBe("/api/instances/import");
  });

  it("overwrites the named agent, and refuses without a matching --confirm", async () => {
    const h = harness([], { readPayload: async () => JSON.stringify({ version: 1 }) });

    await expect(leaf(h.command, ["import"])(["acme", "--file", "-"], context({ yes: true }))).rejects.toThrow(
      /--confirm acme is required/,
    );
    expect(h.err.join("")).toContain("overwritten, not merged");
  });
});

describe("agent models", () => {
  it("flattens the provider map into rows, and filters by provider", async () => {
    const body = {
      providers: {
        anthropic: { models: [{ id: "claude-sonnet-4", tier: "balanced", costInput: 3, costOutput: 15, supportsThinking: true }] },
        openai: { models: [{ id: "gpt-4.1", tier: null, costInput: 2, costOutput: 8, supportsThinking: false }] },
      },
    };
    const all = harness([response(body)]);
    await leaf(all.command, ["models"])([], context());
    expect(all.out.join("")).toContain("claude-sonnet-4");
    expect(all.out.join("")).toContain("gpt-4.1");

    const one = harness([response(body)]);
    await leaf(one.command, ["models"])(["--provider", "openai"], context());
    expect(one.out.join("")).not.toContain("claude-sonnet-4");
  });
});

describe("agent governance", () => {
  it("reads the assignment list as a bare array, which is what the engine sends", async () => {
    const h = harness([
      response([
        {
          assignmentId: "a-1",
          policyName: "PII redaction",
          category: "privacy",
          gateType: "regex",
          enforcement: "block",
          enabled: true,
        },
      ]),
    ]);

    await leaf(h.command, ["governance", "show"])(["acme"], context());

    expect(h.out.join("")).toMatch(/a-1\s+PII redaction\s+privacy\s+regex\s+block\s+yes/);
  });

  it("needs an assignments array", async () => {
    const h = harness([], { readPayload: async () => JSON.stringify({ policies: [] }) });

    await expect(leaf(h.command, ["governance", "set"])(["acme", "--file", "-"], context({ yes: true }))).rejects.toThrow(
      /needs an "assignments" array/,
    );
  });
});
