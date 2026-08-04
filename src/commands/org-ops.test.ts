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

const WORKSPACES = {
  workspaces: [
    { id: "ws-1", slug: "general", name: "General", isDefault: true, createdAt: null, updatedAt: null },
    { id: "ws-2", slug: "labs", name: "Labs", isDefault: false, createdAt: null, updatedAt: null },
  ],
};

/** The shareable key set the engine serves at the organisation level. */
const ORG_SECRETS = {
  secrets: [
    { key: "openai_api_key", configured: true },
    { key: "anthropic_api_key", configured: false },
  ],
};

const ISSUABLE = { permissions: ["agent:read", "agent:write", "org:read"] };

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
  return { path: ["org"], global: { json: false, yes: false, dryRun: false, org: "default", ...global } };
}

function leaf(commands: Record<string, Command>, path: string[]) {
  let node: Command | undefined = commands[path[0]];
  for (const segment of path.slice(1)) node = node?.children?.[segment];
  if (node?.run === undefined) throw new Error(`No such action: ${path.join(" ")}`);
  return node.run.bind(node);
}

describe("org secrets", () => {
  it("reports presence, never a value", async () => {
    const h = harness([response(ORG_SECRETS)]);

    await leaf(h.commands, ["org", "secrets", "show"])([], context());

    const table = h.out.join("");
    expect(table).toMatch(/openai_api_key\s+yes/);
    expect(table).toMatch(/anthropic_api_key\s+no/);
  });

  it("sends the value read from a file, and keeps it out of the recap", async () => {
    const h = harness([response(ORG_SECRETS), response({ secrets: [] })], { readPayload: async () => "sk-live-42\n" });

    await leaf(h.commands, ["org", "secrets", "set"])(
      ["--key", "openai_api_key", "--file", "key.txt"],
      context({ yes: true }),
    );

    const recap = h.err.join("");
    expect(recap).toContain("10 characters from key.txt");
    // The one thing that must never appear anywhere but the request body.
    expect(recap).not.toContain("sk-live-42");
    expect(h.out.join("")).not.toContain("sk-live-42");
    expect(h.calls[1]).toMatchObject({
      method: "PUT",
      path: "/api/organizations/default/secrets",
      body: { secrets: [{ key: "openai_api_key", value: "sk-live-42" }] },
    });
  });

  it("says the write reaches every agent that has no key of its own", async () => {
    const h = harness([response(ORG_SECRETS), response({ secrets: [] })], { readPayload: async () => "v" });

    await leaf(h.commands, ["org", "secrets", "set"])(["--key", "openai_api_key", "--file", "-"], context({ yes: true }));

    expect(h.err.join("")).toContain("Every agent in default without its own openai_api_key");
  });

  // A key the organisation cannot share (an inbound credential) would be stored
  // and then silently ignored at resolution time.
  it("refuses a key the organisation cannot share, naming the ones it can", async () => {
    const h = harness([response(ORG_SECRETS)], { readPayload: async () => "v" });

    await expect(
      leaf(h.commands, ["org", "secrets", "set"])(["--key", "auth_api_key", "--file", "-"], context({ yes: true })),
    ).rejects.toThrow(/cannot share a credential named "auth_api_key".*openai_api_key/s);
  });

  it("refuses to remove a credential that is not configured", async () => {
    const h = harness([response(ORG_SECRETS)]);

    await expect(
      leaf(h.commands, ["org", "secrets", "unset"])(["--key", "anthropic_api_key"], context({ yes: true })),
    ).rejects.toThrow(/no stored anthropic_api_key/);
  });
});

describe("apikey", () => {
  it("prints the token on stdout alone, and the warning on stderr", async () => {
    const h = harness([
      response(ISSUABLE),
      response({ key: { id: "k-1", name: "ci" }, token: "pk_k-1_secret" }, 201),
    ]);

    await leaf(h.commands, ["apikey", "create"])(["ci", "--permissions", "agent:read"], context({ yes: true }));

    // stdout is exactly the token, so `… > key.txt` captures it and nothing else.
    expect(h.out.join("")).toBe("pk_k-1_secret\n");
    expect(h.err.join("")).toContain("cannot be shown again");
  });

  it("validates every permission against the engine's issuable set first", async () => {
    const h = harness([response(ISSUABLE)]);

    await expect(
      leaf(h.commands, ["apikey", "create"])(["ci", "--permissions", "agent:read,agent:destroy"], context({ yes: true })),
    ).rejects.toThrow(/Not issuable in default: agent:destroy/);
    expect(h.calls).toHaveLength(1);
  });

  it("fails loudly when the engine answers a create without a token", async () => {
    const h = harness([response(ISSUABLE), response({ key: { id: "k-1" } }, 201)]);

    await expect(
      leaf(h.commands, ["apikey", "create"])(["ci", "--permissions", "agent:read"], context({ yes: true })),
    ).rejects.toThrow(/answered without a token/);
  });

  it("says a permission update replaces rather than adds", async () => {
    const h = harness([response(ISSUABLE), response({ key: { id: "k-1" } })]);

    await leaf(h.commands, ["apikey", "update"])(["k-1", "--permissions", "org:read"], context({ yes: true }));

    expect(h.err.join("")).toContain("Replace the permission set");
    expect(h.calls[1]).toMatchObject({ method: "PATCH", path: "/api/organizations/default/api-keys/k-1" });
  });

  it("requires something to change", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, ["apikey", "update"])(["k-1"], context({ yes: true }))).rejects.toThrow(
      /needs --name, --permissions or --expires-at/,
    );
  });

  it("requires a matching --confirm before revoking", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, ["apikey", "delete"])(["k-1"], context({ yes: true }))).rejects.toThrow(
      /--confirm k-1 is required/,
    );
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("workspace bindings", () => {
  it("resolves each binding's workspace id back to its slug", async () => {
    const h = harness([
      response({ bindings: [{ userId: "u-1", workspaceId: "ws-2", roleKey: "member" }] }),
      response(WORKSPACES),
    ]);

    await leaf(h.commands, ["workspace", "bindings"])([], context());

    const table = h.out.join("");
    expect(table).toMatch(/labs\s+u-1\s+member/);
    expect(table).not.toContain("ws-2");
  });

  it("addresses a workspace member by the workspace's id, resolved from the slug", async () => {
    const h = harness([response(WORKSPACES), response({ ok: true })]);

    await leaf(h.commands, ["workspace", "member", "set"])(["labs", "u-1", "--role", "member"], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({
      method: "PUT",
      path: "/api/organizations/default/workspaces/ws-2/members/u-1",
      body: { roleKey: "member" },
    });
  });

  it("says an unbind leaves the organisation-scope role alone", async () => {
    const h = harness([response(WORKSPACES), response({ ok: true })]);

    await leaf(h.commands, ["workspace", "member", "remove"])(
      ["labs", "u-1", "--confirm", "u-1"],
      context({ yes: true }),
    );

    expect(h.err.join("")).toContain("organisation-scope role, if any, is untouched");
  });
});

describe("member set-role", () => {
  it("assigns the role at the organisation scope", async () => {
    const h = harness([response({ member: { userId: "u-1" } })]);

    await leaf(h.commands, ["member", "set-role"])(["u-1", "--role", "admin"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({
      method: "PUT",
      path: "/api/organizations/default/members/u-1",
      body: { roleKey: "admin" },
    });
  });

  it("needs a role", async () => {
    const h = harness([]);

    await expect(leaf(h.commands, ["member", "set-role"])(["u-1"], context({ yes: true }))).rejects.toThrow(
      /needs --role/,
    );
  });
});

describe("org plugins", () => {
  it("shows which plugins this organisation is granted", async () => {
    const h = harness([
      response({ plugins: [{ name: "sales", version: "1.2.0", compatible: true, enabled: false }] }),
    ]);

    await leaf(h.commands, ["org", "plugins"])([], context());

    expect(h.out.join("")).toMatch(/sales\s+1\.2\.0\s+no\s+yes/);
  });
});

describe("dry runs", () => {
  // A dry run may still READ — the validation that makes the recap accurate is
  // the point of it. What it must never do is send a write.
  it("sends no write, for every writing family", async () => {
    const cases: [string[], string[], ApiResponse[]][] = [
      [["org", "secrets", "unset"], ["--key", "openai_api_key"], [response(ORG_SECRETS)]],
      [["apikey", "create"], ["ci", "--permissions", "agent:read"], [response(ISSUABLE)]],
      [["member", "set-role"], ["u-1", "--role", "admin"], []],
      [["workspace", "member", "set"], ["labs", "u-1", "--role", "member"], []],
    ];
    for (const [path, args, reads] of cases) {
      const h = harness(reads);
      await leaf(h.commands, path)(args, context({ dryRun: true }));
      const writes = h.calls.filter((c) => c.method !== undefined && c.method !== "GET");
      expect(writes, path.join(" ")).toEqual([]);
    }
  });
});
