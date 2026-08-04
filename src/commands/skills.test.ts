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

/**
 * Two rows sharing a name, which the catalog genuinely allows: an organisation
 * may override a platform-owned skill, and only `owner` tells them apart.
 */
const CATALOG = {
  skills: [
    { name: "triage", description: "Sort tickets", owner: "organization", category: "support", requiredEnv: [{ name: "ZENDESK_TOKEN" }] },
    { name: "triage", description: "Sort tickets", owner: "platform", category: "support" },
  ],
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
  return { path: ["skill"], global: { json: false, yes: false, dryRun: false, org: "default", ...global } };
}

function leaf(commands: Record<string, Command>, action: string) {
  const node: Command | undefined = commands.skill?.children?.[action];
  if (node?.run === undefined) throw new Error(`No such action: skill ${action}`);
  return node.run.bind(node);
}

describe("skill list", () => {
  it("prints the owner, because two rows may share a name", async () => {
    const h = harness([response(CATALOG)]);

    await leaf(h.commands, "list")([], context());

    const table = h.out.join("");
    expect(table).toContain("OWNER");
    expect(table).toMatch(/triage\s+organization/);
    expect(table).toMatch(/triage\s+platform/);
  });

  it("filters by owner locally", async () => {
    const h = harness([response(CATALOG)]);

    await leaf(h.commands, "list")(["--owner", "platform"], context());

    const rows = h.out.join("").split("\n").filter((line) => line.includes("triage"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("platform");
  });

  it("rejects an owner the engine does not have", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "list")(["--owner", "everyone"], context())).rejects.toThrow(/"organization" or "platform"/);
  });
});

describe("skill show", () => {
  it("prints the body alone under --content, so it pipes", async () => {
    const h = harness([response({ name: "triage", description: "d", owner: "organization", content: "# Triage\nsteps" })]);

    await leaf(h.commands, "show")(["triage", "--content"], context());

    expect(h.out.join("")).toBe("# Triage\nsteps\n");
  });
});

describe("skill set", () => {
  // Create and update are different verbs on different routes, and the engine
  // refuses a create for a name it already holds.
  it("updates when the organisation already owns the name", async () => {
    const h = harness([response(CATALOG), response({ skill: { name: "triage" } })], { readPayload: async () => "new body" });

    await leaf(h.commands, "set")(["triage", "--file", "s.md", "--changelog", "tweak"], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({
      method: "PUT",
      path: "/api/organizations/default/skills/triage",
      body: { description: "Sort tickets", content: "new body", changelog: "tweak" },
    });
    expect(h.out.join("")).toContain("Published a new version");
  });

  it("creates when it does not, and says so", async () => {
    const h = harness([response({ skills: [] }), response({ skill: { name: "intake" } }, 201)], {
      readPayload: async () => "body",
    });

    await leaf(h.commands, "set")(["intake", "--file", "-", "--description", "Intake"], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "POST", path: "/api/organizations/default/skills" });
    expect(h.out.join("")).toContain("Created skill intake");
  });

  // A platform row with the same name is not this organisation's to version.
  it("treats a platform-owned name as absent, so the write creates an override", async () => {
    const h = harness([response({ skills: [CATALOG.skills[1]] }), response({ skill: {} }, 201)], {
      readPayload: async () => "body",
    });

    await leaf(h.commands, "set")(["triage", "--file", "-", "--description", "Ours"], context({ yes: true }));

    expect(h.calls[1].method).toBe("POST");
  });

  it("needs a description to create, but not to version", async () => {
    const h = harness([response({ skills: [] })], { readPayload: async () => "body" });

    await expect(leaf(h.commands, "set")(["intake", "--file", "-"], context({ yes: true }))).rejects.toThrow(
      /needs --description/,
    );
  });

  it("refuses an empty payload", async () => {
    const h = harness([], { readPayload: async () => "   \n" });

    await expect(leaf(h.commands, "set")(["intake", "--file", "-"], context({ yes: true }))).rejects.toThrow(
      /contained no content/,
    );
  });
});

describe("skill import", () => {
  it("names what the engine skipped, which the counts alone hide", async () => {
    const h = harness([response({ created: ["a"], updated: [], skipped: ["b", "c"] })], {
      readPayload: async () => JSON.stringify({ skills: [{ slug: "a" }, { slug: "b" }, { slug: "c" }] }),
    });

    await leaf(h.commands, "import")(["--file", "bundle.json"], context({ yes: true }));

    expect(h.out.join("")).toContain("created 1, updated 0, skipped 2");
    expect(h.err.join("")).toContain("skipped: b, c");
  });

  it("refuses a payload that is not the object the export produces", async () => {
    const h = harness([], { readPayload: async () => "[]" });

    await expect(leaf(h.commands, "import")(["--file", "-"], context({ yes: true }))).rejects.toThrow(
      /must be a JSON object/,
    );
  });
});

describe("skill export", () => {
  it("addresses the catalog bundle when no name is given", async () => {
    const h = harness([response({ version: 1, skills: [] })]);

    await leaf(h.commands, "export")([], context());

    expect(h.calls[0].path).toBe("/api/organizations/default/skills/catalog/export");
  });

  it("addresses one skill's bundle when a name is", async () => {
    const h = harness([response({ version: 1 })]);

    await leaf(h.commands, "export")(["triage"], context());

    expect(h.calls[0].path).toBe("/api/organizations/default/skills/triage/export");
  });
});

describe("skill delete", () => {
  it("requires a matching --confirm and says the version history goes too", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "delete")(["triage"], context({ yes: true }))).rejects.toThrow(
      /--confirm triage is required/,
    );
    expect(h.err.join("")).toContain("version history");
  });
});
