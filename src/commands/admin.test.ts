// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import { ConfigError } from "../exit.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import type { ServiceDependencies } from "../runtime/service.js";
import { createAdminCommands } from "./admin.js";

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: {
    dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" },
    prod: { baseUrl: "https://acme.polyant.ai", keyEnv: "POLYANT_KEY_PROD", prod: true },
  },
};

/** The shapes the engine serves, read from a live instance. */
const SERVICE_CONTEXT = { organization: { slug: "default", name: "Default Organization" }, permissions: [], workspaces: [] };
const WORKSPACES = {
  workspaces: [
    { id: "ws-1", slug: "general", name: "General", isDefault: true, createdAt: null, updatedAt: "2026-07-20T10:00:00.000Z" },
    { id: "ws-2", slug: "sales", name: "Sales", isDefault: false, createdAt: null, updatedAt: null },
  ],
};
const MEMBERS = {
  members: [
    { userId: "u-1", email: "ada@example.com", name: "Ada", roleKey: "owner" },
    { userId: "u-2", email: "bob@example.com", name: null, roleKey: "member" },
  ],
};
const PERMISSIONS = { permissions: ["agent:read", "agent:write", "org:read"] };

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
    env: { POLYANT_KEY_DEV: "pk_dev_secret", POLYANT_KEY_PROD: "pk_prod_secret" },
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
  return { path: ["org"], global: { json: false, yes: false, dryRun: false, ...global } };
}

function leaf(commands: Record<string, Command>, family: string, action: string) {
  const node = commands[family]?.children?.[action];
  if (node?.run === undefined) throw new Error(`No such action: ${family} ${action}`);
  return node.run.bind(node);
}

describe("organisation resolution", () => {
  // A management key belongs to one organisation and service-context reports it,
  // so --org is a way to be explicit rather than something to look up.
  it("resolves the organisation from the key when no flag supplies one", async () => {
    const h = harness([response(SERVICE_CONTEXT), response(WORKSPACES)]);

    await leaf(h.commands, "workspace", "list")([], context());

    expect(h.calls[0].path).toBe("/api/service-context");
    expect(h.calls[1].path).toBe("/api/organizations/default/workspaces");
  });

  it("prefers an explicit --org and then asks the engine nothing", async () => {
    const h = harness([response(WORKSPACES)]);

    await leaf(h.commands, "workspace", "list")([], context({ org: "acme" }));

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].path).toBe("/api/organizations/acme/workspaces");
  });

  it("fails with a usable message when neither the flag nor the key names one", async () => {
    const h = harness([response({ permissions: [] })]);

    await expect(leaf(h.commands, "workspace", "list")([], context())).rejects.toThrow(/pass --org <slug>/);
  });

  it("percent-encodes the organisation in the path", async () => {
    const h = harness([response(WORKSPACES)]);

    await leaf(h.commands, "workspace", "list")([], context({ org: "a/b" }));

    expect(h.calls[0].path).toBe("/api/organizations/a%2Fb/workspaces");
  });
});

describe("org list", () => {
  it("renders the single organisation a management key can see", async () => {
    const h = harness([response({ organizations: [{ id: "org-1", slug: "default", name: "Default Organization", isDefault: true }] })]);

    await leaf(h.commands, "org", "list")([], context());

    expect(h.calls[0].path).toBe("/api/organizations");
    const table = h.out.join("");
    expect(table).toContain("default");
    expect(table).toContain("Default Organization");
  });

  it("passes the body through unchanged with --json", async () => {
    const body = { organizations: [{ id: "org-1", slug: "default", name: "D" }] };
    const h = harness([response(body)]);

    await leaf(h.commands, "org", "list")([], context({ json: true }));

    expect(h.out.join("")).toBe(JSON.stringify(body));
  });
});

describe("workspace", () => {
  it("lists workspaces by slug and marks the default", async () => {
    const h = harness([response(WORKSPACES)], {});

    await leaf(h.commands, "workspace", "list")([], context({ org: "default" }));

    const table = h.out.join("");
    expect(table).toMatch(/general\s+General\s+yes/);
    expect(table).toMatch(/sales\s+Sales\s+no/);
  });

  it("creates a workspace after a recap, defaulting the name to the slug", async () => {
    const h = harness([response({ workspace: { slug: "labs" } }, 201)]);

    await leaf(h.commands, "workspace", "create")(["labs"], context({ org: "default", yes: true }));

    expect(h.err.join("")).toContain('Add workspace labs named "labs"');
    expect(h.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/organizations/default/workspaces",
      body: { slug: "labs", name: "labs" },
    });
  });

  // PATCH /workspaces/:workspaceId matches on the uuid, so the slug the user
  // typed has to be resolved off the list before the path can be assembled.
  it("resolves the slug to an id before addressing an update", async () => {
    const h = harness([
      response({ workspaces: [{ id: "ws-1", slug: "labs", name: "Labs", isDefault: false }] }),
      response({ workspace: { slug: "labs" } }),
    ]);

    await leaf(h.commands, "workspace", "update")(["labs", "--name", "Labs"], context({ org: "default", yes: true }));

    expect(h.calls[1]).toMatchObject({
      method: "PATCH",
      path: "/api/organizations/default/workspaces/ws-1",
      body: { name: "Labs" },
    });
  });

  it("names the workspace the organisation does not have", async () => {
    const h = harness([response({ workspaces: [] })]);

    await expect(leaf(h.commands, "workspace", "update")(["labs", "--name", "Labs"], context({ org: "default", yes: true })))
      .rejects.toThrow(/has no workspace "labs"/);
  });

  it("refuses an update with nothing to change", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "workspace", "update")(["labs"], context({ org: "default", yes: true })))
      .rejects.toThrow(/needs --name/);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("requires a matching --confirm before deleting, and says deletion is final", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "workspace", "delete")(["labs"], context({ org: "default", yes: true })))
      .rejects.toThrow(/--confirm labs is required/);
    expect(h.err.join("")).toContain("there is no archive");
    expect(h.request).not.toHaveBeenCalled();
  });

  it("deletes once --yes and --confirm agree", async () => {
    const h = harness([
      response({ workspaces: [{ id: "ws-1", slug: "labs", name: "Labs", isDefault: false }] }),
      response({ deleted: true }),
    ]);

    await leaf(h.commands, "workspace", "delete")(["labs", "--confirm", "labs"], context({ org: "default", yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "DELETE", path: "/api/organizations/default/workspaces/ws-1" });
    expect(h.out.join("")).toContain("Deleted workspace labs.");
  });

  it("writes nothing on a dry run", async () => {
    const h = harness([]);

    await leaf(h.commands, "workspace", "create")(["labs"], context({ org: "default", dryRun: true }));

    expect(h.request).not.toHaveBeenCalled();
    expect(h.err.join("")).toContain("dry-run");
  });

  it("requires --yes against a production target", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "workspace", "create")(["labs"], context({ org: "default", target: "prod" })))
      .rejects.toThrow(/targets production/);
  });
});

describe("member", () => {
  it("lists members with their role", async () => {
    const h = harness([response(MEMBERS)]);

    await leaf(h.commands, "member", "list")([], context({ org: "default" }));

    const table = h.out.join("");
    expect(table).toContain("ada@example.com");
    expect(table).toContain("owner");
    // A null name must read as absent, not as "null".
    expect(table).not.toContain("null");
  });

  // There is no per-member route, so the selection is local over the list.
  it("selects one member by email or by user id, without a second request", async () => {
    const byEmail = harness([response(MEMBERS)]);
    await leaf(byEmail.commands, "member", "show")(["bob@example.com"], context({ org: "default" }));
    expect(byEmail.calls).toHaveLength(1);
    expect(byEmail.out.join("")).toContain("u-2");

    const byId = harness([response(MEMBERS)]);
    await leaf(byId.commands, "member", "show")(["u-1"], context({ org: "default" }));
    expect(byId.out.join("")).toContain("ada@example.com");
  });

  it("names the organisation when the member is not in it", async () => {
    const h = harness([response(MEMBERS)]);

    await expect(leaf(h.commands, "member", "show")(["nobody@example.com"], context({ org: "default" })))
      .rejects.toThrow(/has no member "nobody@example.com"/);
  });

  // Shipped knowing the engine refuses it for a machine key: the recap says so
  // rather than letting a bare 403 look like a permission mistake.
  it("recaps that removal needs a user principal before sending anything", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "member", "remove")(["u-2"], context({ org: "default", yes: true })))
      .rejects.toThrow(/--confirm u-2 is required/);
    expect(h.err.join("")).toContain("Requires a user principal");
  });
});

describe("role", () => {
  it("explains that an empty list means no custom roles, not no roles", async () => {
    const h = harness([response({ roles: [] })]);

    await leaf(h.commands, "role", "list")([], context({ org: "default" }));

    expect(h.out.join("")).toContain("no custom roles");
  });

  it("shows a role's permissions", async () => {
    const h = harness([response({ roles: [{ id: "r-1", key: "auditor", name: "Auditor", permissions: ["audit_log:read"] }] })]);

    await leaf(h.commands, "role", "show")(["auditor"], context({ org: "default" }));

    expect(h.out.join("")).toContain("audit_log:read");
  });

  it("prints the grantable permission keys one per line, sorted", async () => {
    const h = harness([response(PERMISSIONS)]);

    await leaf(h.commands, "role", "permissions")([], context({ org: "default" }));

    expect(h.out.join("")).toBe("agent:read\nagent:write\norg:read\n");
  });

  // A typo must fail naming the offending key, not as an opaque remote 400.
  it("validates every permission against the engine's grantable set first", async () => {
    const h = harness([response(PERMISSIONS)]);

    await expect(
      leaf(h.commands, "role", "create")(["auditor", "--permissions", "agent:read,agent:destroy"], context({ org: "default", yes: true })),
    ).rejects.toThrow(/Not grantable in default: agent:destroy/);
    // The catalogue was fetched; the role was not created.
    expect(h.calls).toHaveLength(1);
  });

  it("creates a role once every permission is grantable", async () => {
    const h = harness([response(PERMISSIONS), response({ role: { key: "auditor" } }, 201)]);

    await leaf(h.commands, "role", "create")(["auditor", "--permissions", "agent:read, org:read"], context({ org: "default", yes: true }));

    expect(h.calls[1]).toMatchObject({
      method: "POST",
      path: "/api/organizations/default/roles",
      body: { key: "auditor", name: "auditor", permissions: ["agent:read", "org:read"] },
    });
  });

  it("requires at least one permission to create a role", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "role", "create")(["auditor"], context({ org: "default", yes: true })))
      .rejects.toThrow(/needs --permissions/);
  });

  it("requires a matching --confirm before deleting a role", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "role", "delete")(["r-1"], context({ org: "default", yes: true })))
      .rejects.toThrow(/--confirm r-1 is required/);
  });

  // DELETE /roles/:roleId matches on the uuid, so the key gets resolved first.
  it("resolves the role key to an id before deleting", async () => {
    const h = harness([
      response({ roles: [{ id: "r-1", key: "auditor", name: "Auditor", permissions: [] }] }),
      response({ deleted: true }),
    ]);

    await leaf(h.commands, "role", "delete")(["auditor", "--confirm", "auditor"], context({ org: "default", yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "DELETE", path: "/api/organizations/default/roles/r-1" });
  });
});

describe("usage errors", () => {
  it("rejects an unknown option instead of forwarding it", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "workspace", "create")(["labs", "--label", "x"], context({ org: "default", yes: true })))
      .rejects.toThrow(/Unknown workspace create option --label/);
  });

  it("names the missing positional argument", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, "workspace", "create")([], context({ org: "default" }))).rejects.toThrow(ConfigError);
    await expect(leaf(h.commands, "member", "show")([], context({ org: "default" }))).rejects.toThrow(/needs a user id or email/);
    await expect(leaf(h.commands, "role", "show")([], context({ org: "default" }))).rejects.toThrow(/needs a role key/);
  });
});
