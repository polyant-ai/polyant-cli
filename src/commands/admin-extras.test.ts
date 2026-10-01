// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import { parseInvocation, type GlobalOptions } from "../runtime/global-options.js";
import type { ServiceDependencies } from "../runtime/service.js";
import { createAdminCommands } from "./admin.js";

/**
 * The administration subtrees the CLI grew for the engine's provider governance,
 * shared knowledge libraries, audit trails and invitations. They share
 * `admin.test.ts`'s harness rather than its file: the same `createAdminCommands`
 * with a different set of routes behind it.
 */

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" } },
};

const WORKSPACES = {
  workspaces: [
    { id: "ws-1", slug: "general", name: "General", isDefault: true, createdAt: null, updatedAt: null },
    { id: "ws-2", slug: "sales", name: "Sales", isDefault: false, createdAt: null, updatedAt: null },
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
  return { path: ["org"], global: { json: false, yes: false, dryRun: false, org: "acme", ...global } };
}

/**
 * Runs argv the way the binary does, global parser first, for the flags the
 * parser owns: handed to a command directly, `--workspace` reaches it in a test
 * and never in use.
 */
async function invoke(commands: Record<string, Command>, argv: string[]): Promise<void> {
  const { path, args, global } = parseInvocation(argv, commands);
  await leaf(commands, path)(args, { path, global: { ...global, org: global.org ?? "acme" } });
}

function leaf(commands: Record<string, Command>, path: string[]) {
  let node: Command | undefined = commands[path[0]];
  for (const segment of path.slice(1)) node = node?.children?.[segment];
  if (node?.run === undefined) throw new Error(`No such action: ${path.join(" ")}`);
  return node.run.bind(node);
}

// --- audit -------------------------------------------------------------------

describe("org audit", () => {
  const MANAGEMENT = {
    logs: [
      {
        id: "l-1",
        action: "provider.connection.create",
        actorUserId: "u-1",
        actorEmail: "ada@example.com",
        targetType: "provider_connection",
        targetId: "acme/Predefinita",
        metadata: { provider: "openai", fields: ["api_key"] },
        createdAt: "2026-09-14T09:00:00.000Z",
      },
    ],
    total: 1,
    actions: ["provider.connection.create", "secret.write"],
    targetTypes: ["provider_connection"],
  };

  it("sends every filter under the name the engine reads it by", async () => {
    const h = harness([response(MANAGEMENT)]);

    await leaf(h.commands, ["org", "audit", "management"])(
      ["--action", "secret.write", "--actor", "ada@example.com", "--target-type", "organization", "--from", "2026-09-01", "--limit", "10"],
      context(),
    );

    // `--actor` is `actorEmail` on the wire: the row keeps the address it was
    // written with, so an email still reads an old trail after a rename.
    expect(h.calls[0]).toMatchObject({
      path: "/api/organizations/acme/management-audit-logs",
      query: { action: "secret.write", actorEmail: "ada@example.com", targetType: "organization", from: "2026-09-01", limit: "10" },
    });
  });

  it("prints the metadata a row recorded, which is the only thing that says WHAT changed", async () => {
    const h = harness([response(MANAGEMENT)]);

    await leaf(h.commands, ["org", "audit", "management"])([], context());

    expect(h.out.join("")).toContain("provider=openai");
  });

  // The vocabulary travels with every page and there is no catalogue route, so
  // it is the only way to learn what --action accepts.
  it("reports the actions and target types present, on stderr", async () => {
    const h = harness([response(MANAGEMENT)]);

    await leaf(h.commands, ["org", "audit", "management"])([], context());

    expect(h.err.join("")).toContain("actions: provider.connection.create, secret.write");
  });

  it("falls back to the actor id for a row a machine principal wrote", async () => {
    const h = harness([response({ ...MANAGEMENT, logs: [{ ...MANAGEMENT.logs[0], actorEmail: null }] })]);

    await leaf(h.commands, ["org", "audit", "management"])([], context());

    expect(h.out.join("")).toContain("u-1");
  });

  it("reads the authorization trail from its own route, with its own filters", async () => {
    const h = harness([response({ logs: [], total: 0 })]);

    await invoke(h.commands, ["org", "audit", "authz", "--workspace", "general"]);

    expect(h.calls[0]).toMatchObject({ path: "/api/organizations/acme/authz-audit-logs", query: { workspace: "general" } });
  });
});

// --- provider governance -----------------------------------------------------

describe("org providers and connections", () => {
  const PROVIDERS = {
    organizationId: "org-1",
    providers: ["openai", "anthropic"],
    disabledModels: ["openai/gpt-4o-mini"],
    connections: [{ id: "c-1", name: "Predefinita", provider: "openai", configuredFields: ["api_key"] }],
    managedConnectionsOnly: false,
    credentialShapes: {
      openai: { fields: ["api_key"], accepts: [["api_key"]] },
      bedrock: { fields: ["api_key", "access_key_id", "secret_access_key", "region"], accepts: [["api_key"], ["access_key_id", "secret_access_key"]], alsoRequired: ["region"] },
    },
  };

  it("reports the admission, the switched-off models and the library in one read", async () => {
    const h = harness([response(PROVIDERS)]);

    await leaf(h.commands, ["org", "providers", "show"])([], context());

    const text = h.out.join("");
    expect(text).toContain("admitted providers:        openai, anthropic");
    expect(text).toContain("models switched off:       openai/gpt-4o-mini");
    expect(text).toContain("Predefinita");
  });

  it("checks a credential against the shape the engine reports, before sending it", async () => {
    const h = harness([response(PROVIDERS)], { readPayload: async () => JSON.stringify({ apikey: "sk-1" }) });

    await expect(
      leaf(h.commands, ["org", "connections", "create"])(["Nuova", "--provider", "openai", "--file", "-"], context({ yes: true })),
    ).rejects.toThrow(/it has no field apikey/);
  });

  // Bedrock takes either an api key or a key pair, and the region on top of
  // whichever it is: a partial credential authenticates nothing.
  it("names the modes a provider accepts when the credential is incomplete", async () => {
    const h = harness([response(PROVIDERS)], { readPayload: async () => JSON.stringify({ access_key_id: "a", secret_access_key: "b" }) });

    await expect(
      leaf(h.commands, ["org", "connections", "create"])(["AWS", "--provider", "bedrock", "--file", "-"], context({ yes: true })),
    ).rejects.toThrow(/plus region/);
  });

  it("sends a complete credential and never prints its value", async () => {
    const h = harness([response(PROVIDERS), response({ id: "c-2", name: "Nuova", provider: "openai", configuredFields: ["api_key"] })], {
      readPayload: async () => JSON.stringify({ api_key: "sk-secret-value" }),
    });

    await leaf(h.commands, ["org", "connections", "create"])(["Nuova", "--provider", "openai", "--file", "-"], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "POST", path: "/api/organizations/acme/provider-connections", body: { name: "Nuova", provider: "openai" } });
    expect(`${h.out.join("")}${h.err.join("")}`).not.toContain("sk-secret-value");
  });

  it("says a deleted connection stops the agents on it rather than moving them", async () => {
    const h = harness([response({ deleted: true })]);

    await leaf(h.commands, ["org", "connections", "delete"])(["c-1", "--confirm", "c-1"], context({ yes: true }));

    expect(h.err.join("")).toContain("does not fall back");
  });

  it("refuses to admit a workspace to a provider absent from the organisation's tier", async () => {
    const h = harness([
      response({ providers: [{ provider: "openai", admitted: false }], disabledModels: { organization: [], workspace: [] }, connections: [] }),
    ]);

    await expect(
      leaf(h.commands, ["workspace", "providers", "admit"])(["general", "bedrock"], context({ yes: true })),
    ).rejects.toThrow(/is not admitted to "bedrock".*Admitted: openai/s);
    expect(h.calls.filter((c) => c.method !== undefined && c.method !== "GET")).toEqual([]);
  });

  it("admits a workspace to a provider the organisation holds, without a grant flag to read", async () => {
    // The 1.2.0 shape: every row is a provider the organisation holds.
    const h = harness([
      response({ providers: [{ provider: "openai", admitted: false }], disabledModels: { organization: [], workspace: [] }, connections: [] }),
      response({ ok: true }),
    ]);

    await leaf(h.commands, ["workspace", "providers", "admit"])(["general", "openai"], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "PUT", body: { provider: "openai", admitted: true } });
  });

  it("switches one model off for a workspace", async () => {
    const h = harness([response({ ok: true })]);

    await leaf(h.commands, ["workspace", "providers", "model"])(["general", "openai", "gpt-4o", "--off"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/organizations/acme/workspaces/general/providers/models",
      body: { provider: "openai", modelId: "gpt-4o", enabled: false },
    });
  });

  it("lends a connection to a workspace by id", async () => {
    const h = harness([response({ ok: true })]);

    await leaf(h.commands, ["workspace", "connections", "assign"])(["general", "c-1"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/organizations/acme/workspaces/general/provider-connections",
      body: { connectionId: "c-1", assigned: true },
    });
  });
});

// --- shared knowledge libraries ----------------------------------------------

describe("shared knowledge libraries", () => {
  const LIBRARY = {
    documents: [
      {
        id: "d-1",
        filename: "handbook.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        status: "ready",
        chunkCount: 12,
        errorMessage: null,
        createdAt: null,
        updatedAt: null,
        workspaceIds: ["ws-2"],
      },
    ],
    embedder: { provider: "openai", dimensions: 1536 },
  };

  it("resolves the granted workspace ids back to the slugs a person passes", async () => {
    const h = harness([response(LIBRARY), response(WORKSPACES)]);

    await leaf(h.commands, ["org", "knowledge", "list"])([], context());

    expect(h.out.join("")).toContain("sales");
  });

  it("reports the library's embedder, which is why a document can be unusable", async () => {
    const h = harness([response(LIBRARY), response(WORKSPACES)]);

    await leaf(h.commands, ["org", "knowledge", "list"])([], context());

    expect(h.err.join("")).toContain("embedder: openai (1536 dimensions)");
  });

  it("uploads as multipart, which is the only shape the route parses", async () => {
    const h = harness([response({ document: { id: "d-2" } })], { readBytes: async () => new Uint8Array([1, 2, 3]) });

    await leaf(h.commands, ["org", "knowledge", "add"])(["--file", "/tmp/handbook.pdf"], context({ yes: true }));

    const call = h.calls[0];
    expect(call).toMatchObject({ method: "POST", path: "/api/organizations/acme/knowledge/file" });
    expect(call.formData?.get("file")).toBeInstanceOf(Blob);
    expect(call.body).toBeUndefined();
  });

  // A multipart part carries a filename and stdin has none, so "-" is refused
  // rather than uploaded under a made-up name.
  it("refuses stdin for an upload, and says why", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, ["org", "knowledge", "add"])(["--file", "-"], context({ yes: true }))).rejects.toThrow(/stdin has none/);
  });

  it("grants a document to one workspace", async () => {
    const h = harness([response({ assigned: true })]);

    await leaf(h.commands, ["org", "knowledge", "grant"])(["d-1", "sales"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ method: "PUT", path: "/api/organizations/acme/knowledge/d-1/workspaces/sales" });
  });

  it("says a revoke leaves the agent's switch on and reported, rather than clearing it", async () => {
    const h = harness([response({ revoked: true })]);

    await leaf(h.commands, ["org", "knowledge", "revoke"])(["d-1", "sales", "--confirm", "d-1"], context({ yes: true }));

    expect(h.err.join("")).toContain("reported as revoked");
  });

  it("keeps a workspace's own library on its own route", async () => {
    const h = harness([response({ documents: [], embedder: null })]);

    await leaf(h.commands, ["workspace", "knowledge", "list"])(["sales"], context());

    expect(h.calls[0].path).toBe("/api/organizations/acme/workspaces/sales/knowledge");
  });
});

// --- invitations --------------------------------------------------------------

describe("member invitations", () => {
  it("resolves the workspace slug to the id the route takes", async () => {
    const h = harness([response(WORKSPACES), response({ id: "i-1", email: "ada@example.com", token: "inv_abc", emailSent: true, expiresAt: null })]);

    await invoke(h.commands, ["member", "invitations", "create", "ada@example.com", "--role", "member", "--workspace", "sales", "--workspace-role", "viewer", "--yes"]);

    expect(h.calls[1]).toMatchObject({
      method: "POST",
      path: "/api/organizations/acme/invitations",
      body: { email: "ada@example.com", roleKey: "member", workspaceId: "ws-2", workspaceRoleKey: "viewer" },
    });
  });

  it("refuses a workspace role with no workspace to apply it in", async () => {
    const h = harness([]);

    await expect(
      leaf(h.commands, ["member", "invitations", "create"])(["ada@example.com", "--role", "member", "--workspace-role", "viewer"], context({ yes: true })),
    ).rejects.toThrow(/needs --workspace/);
  });

  // The token is shown once and only its hash is kept, and `emailSent` is what
  // tells the admin whether they have to share it by hand.
  it("prints the one-time token and whether the mail actually went out", async () => {
    const h = harness([response({ id: "i-1", email: "ada@example.com", token: "inv_abc", emailSent: false, expiresAt: "2026-09-21T00:00:00.000Z" })]);

    await leaf(h.commands, ["member", "invitations", "create"])(["ada@example.com", "--role", "member"], context({ yes: true }));

    const text = h.out.join("");
    expect(text).toContain("emailSent:  false");
    expect(text).toContain("token:      inv_abc");
  });

  it("keeps accepted and revoked rows unless --pending-only asks otherwise", async () => {
    const invitations = {
      invitations: [
        { id: "i-1", email: "ada@example.com", roleKey: "member", status: "pending", expiresAt: null, createdAt: null, acceptedAt: null, revokedAt: null },
        { id: "i-2", email: "bob@example.com", roleKey: "member", status: "accepted", expiresAt: null, createdAt: null, acceptedAt: null, revokedAt: null },
      ],
    };
    const all = harness([response(invitations)]);
    await leaf(all.commands, ["member", "invitations", "list"])([], context());
    expect(all.out.join("")).toContain("bob@example.com");

    const pending = harness([response(invitations)]);
    await leaf(pending.commands, ["member", "invitations", "list"])(["--pending-only"], context());
    expect(pending.out.join("")).not.toContain("bob@example.com");
  });
});
