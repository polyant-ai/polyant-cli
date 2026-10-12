// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import { ExitCode, RemoteError } from "../exit.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import type { ServiceDependencies } from "../runtime/service.js";
import { createAdminCommands } from "./admin.js";
import { createAgentCommand } from "./agent.js";

/**
 * Credential roles and agent-private connections (engine 1.2.0-ee), the
 * organisation's roles, and the Platform Admin's ambient AWS grant.
 */

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" } },
  contexts: { dev: { target: "dev", org: "acme", workspace: "ws-1" } },
  defaultContext: "dev",
};

function response(body: unknown, status = 200): ApiResponse {
  return { status, raw: JSON.stringify(body), body };
}

function harness(responses: (ApiResponse | Error)[], overrides: Partial<ServiceDependencies> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RequestOptions[] = [];
  const queue = [...responses];
  const request = vi.fn(async (_target: unknown, opts: RequestOptions) => {
    calls.push(opts);
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected request: ${opts.method ?? "GET"} ${opts.path}`);
    if (next instanceof Error) throw next;
    return next;
  });
  const deps: Partial<ServiceDependencies> = {
    request: request as unknown as ServiceDependencies["request"],
    loadConfig: async () => CONFIG,
    env: { POLYANT_KEY_DEV: "pk_dev_secret" },
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
    ...overrides,
  };
  return { agent: createAgentCommand(deps), admin: createAdminCommands(deps), out, err, calls };
}

function context(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["agent"], global: { json: false, yes: false, dryRun: false, ...global } };
}

function leaf(command: Command | undefined, path: string[]) {
  let node: Command | undefined = command;
  for (const segment of path) node = node?.children?.[segment];
  if (node?.run === undefined) throw new Error(`No such action: ${path.join(" ")}`);
  return node.run.bind(node);
}

const OPENAI = { id: "11111111-1111-4111-8111-111111111111", name: "Produzione", provider: "openai", private: false };
const OWN = { id: "22222222-2222-4222-8222-222222222222", name: "Mia", provider: "anthropic", private: true };

const ROLES = {
  roles: [
    {
      role: "chat",
      capability: "model",
      requiredProvider: "anthropic",
      inUse: true,
      connectionId: OWN.id,
      connection: OWN,
      readiness: { ready: true, problem: null, message: null },
      // Filtered by requiredProvider since engine 1.2.0-ee: no openai row here.
      options: [OWN],
    },
    {
      role: "embedding",
      capability: "embedding",
      requiredProvider: null,
      inUse: true,
      connectionId: null,
      connection: null,
      readiness: { ready: false, problem: "unbound", message: 'agent "acme" has no connection bound to its embedding role.' },
      options: [OPENAI],
    },
    {
      role: "voice_tts",
      capability: "tts",
      requiredProvider: "elevenlabs",
      inUse: false,
      connectionId: null,
      connection: null,
      readiness: { ready: false, problem: "unbound", message: "unused" },
      options: [],
    },
  ],
  privateConnections: [{ id: OWN.id, name: OWN.name, provider: "anthropic", configuredFields: ["api_key"], ownerInstanceId: "i-1", usable: true }],
  privateConnectionsAllowed: true,
  ambientAwsGranted: false,
  credentialShapes: {
    anthropic: { fields: ["api_key"], accepts: [["api_key"]] },
    bedrock: { fields: ["api_key", "access_key_id", "secret_access_key", "region"], accepts: [["api_key"], ["access_key_id", "secret_access_key"]], alsoRequired: ["region"] },
  },
  capabilities: { anthropic: ["model"], bedrock: ["embedding", "model", "stt"] },
};

describe("agent provider-roles show", () => {
  it("lists each role with its binding and readiness, the reasons, and what each may take", async () => {
    const h = harness([response(ROLES)]);

    await leaf(h.agent, ["provider-roles", "show"])(["acme"], context());

    expect(h.calls[0].path).toBe("/api/instances/acme/provider-roles");
    const out = h.out.join("");
    expect(out).toMatch(/chat\s+yes\s+Mia \(anthropic\)\s+yes\s+model on anthropic/);
    expect(out).toMatch(/embedding\s+yes\s+\(unbound\)\s+no\s+embedding/);
    expect(out).toContain('embedding: agent "acme" has no connection bound to its embedding role.');
    // A role the agent does not use is not reported as a problem.
    expect(out).not.toContain("voice_tts: unused");
    expect(out).toMatch(new RegExp(`embedding\\s+${OPENAI.id}\\s+Produzione\\s+openai\\s+no`));
    expect(out).toMatch(/private connections allowed:\s+yes/);
    expect(out).toMatch(/ambient AWS identity:\s+not granted/);
  });

  it("passes the engine's body through with --json", async () => {
    const h = harness([response(ROLES)]);

    await leaf(h.agent, ["provider-roles", "show"])(["acme"], context({ json: true }));

    expect(JSON.parse(h.out.join(""))).toEqual(ROLES);
  });
});

describe("agent provider-roles bind", () => {
  it("binds a role to a connection it may take, with the recap naming the previous binding", async () => {
    const h = harness([response(ROLES), response(ROLES)]);

    await leaf(h.agent, ["provider-roles", "bind"])(["acme", "embedding", OPENAI.id], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "PUT", path: "/api/instances/acme/provider-roles/embedding", body: { connectionId: OPENAI.id } });
    expect(h.err.join("")).toContain("Bind embedding to Produzione (openai), replacing (unbound).");
    expect(h.out.join("")).toContain("Bound acme's embedding role to Produzione.");
  });

  it("warns when the engine reports the role still cannot run after the write", async () => {
    const h = harness([response(ROLES), response(ROLES)]);

    await leaf(h.agent, ["provider-roles", "bind"])(["acme", "embedding", OPENAI.id], context({ yes: true }));

    expect(h.err.join("")).toContain("warning: embedding is bound but cannot run yet");
  });

  it("refuses an unknown role, naming the agent's roles", async () => {
    const h = harness([response(ROLES)]);

    await expect(leaf(h.agent, ["provider-roles", "bind"])(["acme", "tts", OPENAI.id], context({ yes: true }))).rejects.toThrow(
      /no role "tts"\. Roles: chat, embedding, voice_tts/,
    );
    expect(h.calls).toHaveLength(1);
  });

  it("refuses a connection the role may not take, listing the ones it may", async () => {
    const h = harness([response(ROLES)]);

    await expect(leaf(h.agent, ["provider-roles", "bind"])(["acme", "embedding", OWN.id], context({ yes: true }))).rejects.toThrow(
      new RegExp(`may take: ${OPENAI.id} \\(Produzione, openai\\)`),
    );
    expect(h.calls).toHaveLength(1);
  });

  // Since engine 1.2.0-ee the options are filtered by the provider the agent
  // runs the role on, so a connection for another provider is refused locally.
  it("refuses a connection for another provider than the role runs on, before writing", async () => {
    const h = harness([response(ROLES)]);

    await expect(leaf(h.agent, ["provider-roles", "bind"])(["acme", "chat", OPENAI.id], context({ yes: true }))).rejects.toThrow(
      /cannot serve model on anthropic\. It may take: 2{8}-/,
    );
    expect(h.calls).toHaveLength(1);
  });

  // A binding the agent can still reach is named even when it no longer fits
  // the role: the engine reports it in `connection`, outside the options.
  it("names a bound connection that no longer fits the role", async () => {
    const stale = {
      ...ROLES,
      roles: [
        {
          ...ROLES.roles[0],
          requiredProvider: "openai",
          connection: OWN,
          options: [OPENAI],
          readiness: { ready: false, problem: "provider_mismatch", message: "bound to anthropic, runs on openai" },
        },
      ],
    };
    const h = harness([response(stale)]);

    await leaf(h.agent, ["provider-roles", "show"])(["acme"], context());

    expect(h.out.join("")).toMatch(/chat\s+yes\s+Mia \(anthropic\)\s+no\s+model on openai/);
    expect(h.out.join("")).toContain("chat: bound to anthropic, runs on openai");
  });

  it("sends nothing on --dry-run", async () => {
    const h = harness([response(ROLES)]);

    await leaf(h.agent, ["provider-roles", "bind"])(["acme", "embedding", OPENAI.id], context({ dryRun: true }));

    expect(h.calls).toHaveLength(1);
  });
});

describe("agent provider-roles unbind", () => {
  it("needs --confirm <role>, then clears the binding with null", async () => {
    const refused = harness([response(ROLES)]);
    await expect(leaf(refused.agent, ["provider-roles", "unbind"])(["acme", "chat"], context({ yes: true }))).rejects.toThrow(/--confirm chat is required/);
    expect(refused.calls).toHaveLength(1);

    const h = harness([response(ROLES), response(ROLES)]);
    await leaf(h.agent, ["provider-roles", "unbind"])(["acme", "chat", "--confirm", "chat"], context({ yes: true }));
    expect(h.calls[1]).toMatchObject({ method: "PUT", path: "/api/instances/acme/provider-roles/chat", body: { connectionId: null } });
    expect(h.err.join("")).toContain("it stops at the next use");
  });
});

describe("agent connections", () => {
  it("lists the agent's private connections from their own route, with USABLE and the roles bound to each", async () => {
    const h = harness([response({ connections: ROLES.privateConnections }), response(ROLES)]);

    await leaf(h.agent, ["connections", "list"])(["acme"], context());

    expect(h.calls[0].path).toBe("/api/instances/acme/provider-connections");
    expect(h.out.join("")).toMatch(new RegExp(`${OWN.id}\\s+Mia\\s+anthropic\\s+api_key\\s+yes\\s+chat`));
    expect(h.err.join("")).not.toContain("USABLE no");
  });

  // Under managed-only a connection made before the switch is still listed, so
  // it can be found and deleted.
  it("marks a connection no role may use under managed-only, and says it can only be deleted", async () => {
    const listed = [{ ...ROLES.privateConnections[0], usable: false }];
    const h = harness([response({ connections: listed }), response(ROLES)]);

    await leaf(h.agent, ["connections", "list"])(["acme"], context());

    expect(h.out.join("")).toMatch(/Mia\s+anthropic\s+api_key\s+no/);
    expect(h.err.join("")).toContain("it can only be deleted");
  });

  it("passes the connection list through with --json, reading nothing else", async () => {
    const body = { connections: ROLES.privateConnections };
    const h = harness([response(body)]);

    await leaf(h.agent, ["connections", "list"])(["acme"], context({ json: true }));

    expect(JSON.parse(h.out.join(""))).toEqual(body);
    expect(h.calls).toHaveLength(1);
  });

  it("creates a private connection checked against the agent's credential shapes, never printing the value", async () => {
    const h = harness([response(ROLES), response({ id: "33333333-3333-4333-8333-333333333333", name: "Nuova", provider: "anthropic" })], {
      readPayload: async () => JSON.stringify({ api_key: "sk-ant-secret" }),
    });

    await leaf(h.agent, ["connections", "create"])(["acme", "Nuova", "--provider", "anthropic", "--file", "-"], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({
      method: "POST",
      path: "/api/instances/acme/provider-connections",
      body: { name: "Nuova", provider: "anthropic", credentials: { api_key: "sk-ant-secret" } },
    });
    expect(`${h.out.join("")}${h.err.join("")}`).not.toContain("sk-ant-secret");
    expect(h.out.join("")).toContain("Created private provider connection Nuova (33333333-3333-4333-8333-333333333333) on acme.");
  });

  // Without the ambient AWS grant a Bedrock credential needs a key of its own.
  it("refuses an incomplete credential before sending it", async () => {
    const h = harness([response(ROLES)], { readPayload: async () => JSON.stringify({ region: "eu-west-1" }) });

    await expect(
      leaf(h.agent, ["connections", "create"])(["acme", "AWS", "--provider", "bedrock", "--file", "-"], context({ yes: true })),
    ).rejects.toThrow(/Provider bedrock needs api_key, or access_key_id \+ secret_access_key, plus region/);
    expect(h.calls).toHaveLength(1);
  });

  it("refuses a private connection where the organisation accepts only its own", async () => {
    const h = harness([response({ ...ROLES, privateConnections: [], privateConnectionsAllowed: false })], {
      readPayload: async () => JSON.stringify({ api_key: "sk" }),
    });

    await expect(
      leaf(h.agent, ["connections", "create"])(["acme", "Nuova", "--provider", "anthropic", "--file", "-"], context({ yes: true })),
    ).rejects.toThrow(/accepts only the connections it prepares/);
  });

  it("rotates a private connection's credential against its own provider", async () => {
    const h = harness([response(ROLES), response({ id: OWN.id, name: "Mia" })], { readPayload: async () => JSON.stringify({ api_key: "sk-2" }) });

    await leaf(h.agent, ["connections", "update"])(["acme", OWN.id, "--file", "-"], context({ yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "PATCH", path: `/api/instances/acme/provider-connections/${OWN.id}`, body: { credentials: { api_key: "sk-2" } } });
    expect(h.err.join("")).toContain("chat authenticates with the new value");
  });

  it("refuses to update a connection the agent does not own", async () => {
    const h = harness([response(ROLES)]);

    await expect(leaf(h.agent, ["connections", "update"])(["acme", OPENAI.id, "--name", "X"], context({ yes: true }))).rejects.toThrow(
      /has no private provider connection/,
    );
  });

  it("deletes with --confirm and surfaces the engine's 409 while a role is bound", async () => {
    const conflict = new RemoteError("This connection is still bound to one of the agent's roles. Bind that role elsewhere first.", ExitCode.Config, 409);
    const h = harness([conflict]);

    await expect(leaf(h.agent, ["connections", "delete"])(["acme", OWN.id, "--confirm", OWN.id], context({ yes: true }))).rejects.toThrow(
      /still bound to one of the agent's roles/,
    );
    expect(h.calls[0]).toMatchObject({ method: "DELETE", path: `/api/instances/acme/provider-connections/${OWN.id}` });
  });
});

describe("org provider-roles", () => {
  const ORG_ROLES = {
    roles: [
      {
        role: "library_embedding",
        capability: "embedding",
        requiredProvider: "openai",
        connectionId: null,
        readiness: { ready: false, problem: "unbound", message: "the organization has no connection bound to its library_embedding role." },
        options: [OPENAI],
      },
    ],
  };
  const orgContext = (global: Partial<GlobalOptions> = {}) => context({ org: "acme", ...global });

  it("shows the organisation's roles with the engine's reason and the options", async () => {
    const h = harness([response(ORG_ROLES)]);

    await leaf(h.admin.org, ["provider-roles", "show"])([], orgContext());

    expect(h.calls[0].path).toBe("/api/organizations/acme/providers/roles");
    const out = h.out.join("");
    expect(out).toMatch(/library_embedding\s+\(unbound\)\s+no\s+embedding on openai/);
    expect(out).toContain("library_embedding: the organization has no connection bound");
  });

  it("binds a role to one of the organisation's connections", async () => {
    const h = harness([response(ORG_ROLES), response(ORG_ROLES)]);

    await leaf(h.admin.org, ["provider-roles", "bind"])(["library_embedding", OPENAI.id], orgContext({ yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "PUT", path: "/api/organizations/acme/providers/roles/library_embedding", body: { connectionId: OPENAI.id } });
  });

  it("unbinds only with --confirm <role>", async () => {
    const h = harness([response(ORG_ROLES), response(ORG_ROLES)]);

    await leaf(h.admin.org, ["provider-roles", "unbind"])(["library_embedding", "--confirm", "library_embedding"], orgContext({ yes: true }));

    expect(h.calls[1]).toMatchObject({ method: "PUT", body: { connectionId: null } });
  });
});

describe("org ambient-aws", () => {
  const pat = { env: { POLYANT_KEY_DEV: "pat_platform_admin" } };

  it("refuses a management key before any request: the route admits only a person", async () => {
    const h = harness([]);

    await expect(leaf(h.admin.org, ["ambient-aws", "show"])(["beta"], context())).rejects.toThrow(/Platform Admin's personal token/);
    expect(h.calls).toEqual([]);
  });

  it("reads the grant of a named organisation", async () => {
    const h = harness([response({ granted: true })], pat);

    await leaf(h.admin.org, ["ambient-aws", "show"])(["beta"], context());

    expect(h.calls[0].path).toBe("/api/platform/organizations/beta/ambient-aws");
    expect(h.out.join("")).toContain("Organisation beta may use the deployment's AWS identity for Bedrock.");
  });

  it("grants with PUT and revokes with DELETE, the revoke behind --confirm <org>", async () => {
    const granted = harness([response({ granted: true })], pat);
    await leaf(granted.admin.org, ["ambient-aws", "grant"])(["beta"], context({ yes: true }));
    expect(granted.calls[0]).toMatchObject({ method: "PUT", path: "/api/platform/organizations/beta/ambient-aws" });
    expect(granted.err.join("")).toContain("billed to the deployment's AWS account");

    const unconfirmed = harness([], pat);
    await expect(leaf(unconfirmed.admin.org, ["ambient-aws", "revoke"])(["beta"], context({ yes: true }))).rejects.toThrow(/--confirm beta is required/);
    expect(unconfirmed.calls).toEqual([]);

    const revoked = harness([response({ granted: false })], pat);
    await leaf(revoked.admin.org, ["ambient-aws", "revoke"])(["beta", "--confirm", "beta"], context({ yes: true }));
    expect(revoked.calls[0]).toMatchObject({ method: "DELETE", path: "/api/platform/organizations/beta/ambient-aws" });
  });
});
