// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import type { ServiceDependencies } from "../runtime/service.js";
import { createAdminCommands } from "./admin.js";

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" } },
};

function response(body: unknown, status = 200): ApiResponse {
  return { status, raw: JSON.stringify(body), body };
}

function harness(responses: ApiResponse[], overrides: Partial<ServiceDependencies> = {}) {
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
  const commands = createAdminCommands({
    request: request as unknown as ServiceDependencies["request"],
    loadConfig: async () => CONFIG,
    env: { POLYANT_KEY_DEV: "pk_dev_secret" },
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
    ...overrides,
  });
  return { commands, request, out, err, calls };
}

function context(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["governance"], global: { json: false, yes: false, dryRun: false, org: "default", ...global } };
}

function leaf(commands: Record<string, Command>, path: string[]) {
  let node: Command | undefined = commands.governance;
  for (const segment of path) node = node?.children?.[segment];
  if (node?.run === undefined) throw new Error(`No such action: governance ${path.join(" ")}`);
  return node.run.bind(node);
}

describe("governance analytics", () => {
  // Two different aggregations behind one word, picked by flag rather than
  // hidden: the workspace's, and the whole organisation's.
  it("addresses the workspace route by default", async () => {
    const h = harness([response({ total: 0 })]);

    await leaf(h.commands, ["analytics"])(["--from", "2026-01-01"], context());

    expect(h.calls[0]).toMatchObject({ path: "/api/governance/analytics", query: { from: "2026-01-01" } });
  });

  it("addresses the organisation route under --org", async () => {
    const h = harness([response({ total: 0 })]);

    await leaf(h.commands, ["analytics"])(["--org"], context());

    expect(h.calls[0].path).toBe("/api/organizations/default/governance/analytics");
  });
});

describe("governance policy list", () => {
  it("reads a bare array, which is what the engine's catalog route sends", async () => {
    const h = harness([
      response([
        { id: "r-1", policyId: "builtin:pii", name: "PII", category: "privacy", level: "org", gateType: "regex", severity: "high", organizationId: null },
        { id: "r-2", policyId: "custom:tone", name: "Tone", category: "quality", level: "org", gateType: "llm", severity: "low", organizationId: "o-1" },
      ]),
    ]);

    await leaf(h.commands, ["policy", "list"])([], context());

    const table = h.out.join("");
    // A built-in is visible to every organisation and is not theirs to delete.
    expect(table).toMatch(/builtin:pii\s+PII\s+privacy\s+regex\s+high\s+yes/);
    expect(table).toMatch(/custom:tone.*\sno/);
  });
});

describe("governance policy create", () => {
  it("needs a policyId in the payload", async () => {
    const h = harness([], { readPayload: async () => JSON.stringify({ name: "Tone" }) });

    await expect(leaf(h.commands, ["policy", "create"])(["--file", "-"], context({ yes: true }))).rejects.toThrow(
      /needs a policyId/,
    );
  });

  // The engine reserves the built-in prefixes and answers 400; saying so first
  // costs one comparison and names the fix.
  it("warns when the policy id does not carry the custom prefix", async () => {
    const h = harness([response({ policy: {} }, 201)], {
      readPayload: async () => JSON.stringify({ policyId: "builtin:pii", name: "PII", category: "privacy", gateType: "regex" }),
    });

    await leaf(h.commands, ["policy", "create"])(["--file", "-"], context({ yes: true }));

    expect(h.err.join("")).toContain('normally starts with "custom:"');
  });

  it("says creating a policy does not assign it", async () => {
    const h = harness([response({ policy: {} }, 201)], {
      readPayload: async () => JSON.stringify({ policyId: "custom:tone", name: "Tone", category: "quality", gateType: "llm" }),
    });

    await leaf(h.commands, ["policy", "create"])(["--file", "-"], context({ yes: true }));

    expect(h.err.join("")).toContain("does not assign it");
    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/organizations/default/governance/policies" });
  });

  it("refuses a payload that is not a JSON object", async () => {
    const h = harness([], { readPayload: async () => "not json" });

    await expect(leaf(h.commands, ["policy", "create"])(["--file", "-"], context({ yes: true }))).rejects.toThrow(
      /is not valid JSON/,
    );
  });
});

describe("governance policy delete", () => {
  it("requires a matching --confirm and says every assignment stops", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, ["policy", "delete"])(["r-2"], context({ yes: true }))).rejects.toThrow(
      /--confirm r-2 is required/,
    );
    expect(h.err.join("")).toContain("stops being governed by it");
  });
});

describe("governance tools", () => {
  it("renders the registry the organisation may actually see", async () => {
    const h = harness([response({ tools: [{ name: "web.search", description: "Search" }] })]);

    await leaf(h.commands, ["tools"])([], context());

    expect(h.out.join("")).toMatch(/web\.search\s+Search/);
  });
});
