// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import { ConfigError } from "../exit.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import { createAgentCommand, type AgentCommandDependencies } from "./agent.js";

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: {
    dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" },
    prod: { baseUrl: "https://acme.polyant.ai", keyEnv: "POLYANT_KEY_PROD", prod: true },
  },
  contexts: { dev: { target: "dev", org: "acme", workspace: "ws-1" }, live: { target: "prod", org: "acme", workspace: "ws-9" } },
  defaultContext: "dev",
};

const ENV = { POLYANT_KEY_DEV: "pk_dev_secret", POLYANT_KEY_PROD: "pk_prod_secret" };

/** Fixture shapes were read from the engine's response DTOs, redacted of values. */
const AGENT = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  name: "Acme",
  description: "Support agent",
  status: "active",
  provider: "anthropic",
  model: "claude-sonnet-4",
  authEnabled: true,
  memoryEnabled: true,
  knowledgeEnabled: false,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-20T10:00:00.000Z",
};

function response(body: unknown, status = 200): ApiResponse {
  const raw = JSON.stringify(body);
  return { status, raw, body };
}

interface Harness {
  command: ReturnType<typeof createAgentCommand>;
  request: ReturnType<typeof vi.fn>;
  out: string[];
  err: string[];
  calls: RequestOptions[];
}

function harness(
  responses: ApiResponse[],
  overrides: Partial<AgentCommandDependencies> & { answers?: string[]; isTTY?: boolean } = {},
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const queue = [...responses];
  const calls: RequestOptions[] = [];
  const answers = [...(overrides.answers ?? [])];
  const request = vi.fn(async (_target: unknown, opts: RequestOptions) => {
    calls.push(opts);
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected request: ${opts.method ?? "GET"} ${opts.path}`);
    return next;
  });

  const command = createAgentCommand({
    request: request as unknown as AgentCommandDependencies["request"],
    loadConfig: overrides.loadConfig ?? (async () => CONFIG),
    env: ENV,
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      input: { isTTY: overrides.isTTY ?? false, readLine: async () => answers.shift() ?? "" },
    },
    ...(overrides.readPayload === undefined ? {} : { readPayload: overrides.readPayload }),
  });

  return { command, request, out, err, calls };
}

function context(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["agent"], global: { json: false, yes: false, dryRun: false, ...global } };
}

function leaf(command: ReturnType<typeof createAgentCommand>, path: string[]) {
  let node = command;
  for (const segment of path) {
    const child = node.children?.[segment];
    if (child === undefined) throw new Error(`No such agent action: ${path.join(" ")}`);
    node = child;
  }
  if (node.run === undefined) throw new Error(`${path.join(" ")} is not runnable`);
  return node.run.bind(node);
}

describe("agent list", () => {
  it("renders an aligned table and sends the workspace header", async () => {
    const h = harness([response({ instances: [AGENT, { ...AGENT, slug: "beta", model: null, status: "paused" }] })]);

    await leaf(h.command, ["list"])([], context());

    expect(h.calls[0]).toMatchObject({ path: "/api/instances", workspaceId: "ws-1" });
    const table = h.out.join("");
    expect(table).toContain("SLUG");
    expect(table).toContain("acme");
    expect(table).toMatch(/beta {2}paused/);
    // A null model must read as absent, not as the string "null".
    expect(table).toContain("-");
  });

  it("passes the response body through unchanged with --json", async () => {
    const body = { instances: [AGENT] };
    const h = harness([response(body)]);

    await leaf(h.command, ["list"])([], context({ json: true }));

    expect(h.out.join("")).toBe(JSON.stringify(body));
  });

  it("refuses to run when no context or flag selects a workspace", async () => {
    const h = harness([], { loadConfig: async () => ({ default: "dev", targets: CONFIG.targets }) });

    await expect(leaf(h.command, ["list"])([], context())).rejects.toThrow(ConfigError);
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("agent show", () => {
  it("labels the fields an operator acts on", async () => {
    const h = harness([response({ instance: AGENT })]);

    await leaf(h.command, ["show"])(["acme"], context());

    expect(h.calls[0].path).toBe("/api/instances/acme");
    expect(h.out.join("")).toContain("model:");
    expect(h.out.join("")).toContain("claude-sonnet-4");
  });

  it("reports a missing slug as a usage error", async () => {
    const h = harness([]);
    await expect(leaf(h.command, ["show"])([], context())).rejects.toThrow(/needs an agent slug/);
  });
});

describe("agent create", () => {
  it("recaps the plan on stderr and posts once confirmed", async () => {
    const h = harness([response({ instance: AGENT }, 201)]);

    await leaf(h.command, ["create"])(["acme", "--name", "Acme", "--model", "claude-sonnet-4"], context({ yes: true }));

    expect(h.err.join("")).toContain("Create agent acme");
    expect(h.err.join("")).toContain('Set model to "claude-sonnet-4"');
    expect(h.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/instances",
      body: { slug: "acme", name: "Acme", model: "claude-sonnet-4" },
      workspaceId: "ws-1",
    });
  });

  it("writes nothing on a dry run", async () => {
    const h = harness([]);

    await leaf(h.command, ["create"])(["acme", "--name", "Acme"], context({ dryRun: true }));

    expect(h.request).not.toHaveBeenCalled();
    expect(h.err.join("")).toContain("dry-run");
  });

  it("requires --yes against a production target", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["create"])(["acme", "--name", "Acme"], context({ context: "live" })))
      .rejects.toThrow(/targets production; --yes is required/);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("rejects an unknown option instead of forwarding it", async () => {
    const h = harness([]);
    await expect(leaf(h.command, ["create"])(["acme", "--name", "Acme", "--tools", "x"], context({ yes: true })))
      .rejects.toThrow(/Unknown agent create option --tools/);
  });
});

describe("agent update", () => {
  it("names the previous value of every changed field", async () => {
    const h = harness([response({ instance: AGENT }), response({ instance: { ...AGENT, model: "claude-opus-5" } })]);

    await leaf(h.command, ["update"])(["acme", "--model", "claude-opus-5", "--status", "active"], context({ yes: true }));

    const recap = h.err.join("");
    expect(recap).toContain('Change model from "claude-sonnet-4" to "claude-opus-5"');
    expect(recap).toContain('Leave status unchanged at "active"');
    expect(h.calls[1]).toMatchObject({ method: "PATCH", path: "/api/instances/acme", body: { model: "claude-opus-5", status: "active" } });
  });

  it("refuses an update with no field to change", async () => {
    const h = harness([]);
    await expect(leaf(h.command, ["update"])(["acme"], context({ yes: true }))).rejects.toThrow(/at least one field/);
  });
});

describe("agent delete", () => {
  it("requires a matching --confirm before any request", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["delete"])(["acme"], context({ yes: true }))).rejects.toThrow(/--confirm acme is required/);
    expect(h.request).not.toHaveBeenCalled();
  });

  it("deletes once --yes and --confirm agree with the slug", async () => {
    const h = harness([response({ deleted: true })]);

    await leaf(h.command, ["delete"])(["acme", "--confirm", "acme"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ method: "DELETE", path: "/api/instances/acme" });
    expect(h.out.join("")).toContain("Deleted agent acme.");
  });
});

describe("agent prompt", () => {
  const prompts = { prompts: [{ key: "identity", title: "Identity", content: "You are Acme.\n" }] };

  it("prints one section's content verbatim", async () => {
    const h = harness([response(prompts)]);

    await leaf(h.command, ["prompt", "show"])(["acme", "--section", "identity"], context());

    expect(h.out.join("")).toBe("You are Acme.\n");
  });

  it("names the declared sections when the requested one is absent", async () => {
    const h = harness([response(prompts)]);

    await expect(leaf(h.command, ["prompt", "show"])(["acme", "--section", "tone"], context()))
      .rejects.toThrow(/no prompt section "tone". Declared: identity/);
  });

  it("recaps the character delta before patching a section", async () => {
    const h = harness([response(prompts), response(prompts)], { readPayload: async () => "You are the Acme agent." });

    await leaf(h.command, ["prompt", "set"])(["acme", "--section", "identity", "--file", "-"], context({ yes: true }));

    expect(h.err.join("")).toContain("14 characters become 23");
    expect(h.calls[1]).toMatchObject({
      method: "PATCH",
      path: "/api/instances/acme/prompts",
      body: { sections: [{ key: "identity", content: "You are the Acme agent." }] },
    });
  });
});

describe("agent tools", () => {
  const tools = {
    tools: [
      { name: "web_search", description: null, category: "research", enabled: true, source: "manual" },
      { name: "calendar", description: null, category: "office", enabled: false, source: null },
      { name: "crm", description: null, category: "office", enabled: true, source: "manual" },
    ],
  };

  it("reports added, removed and unchanged tools as a full replacement", async () => {
    const h = harness([response(tools), response(tools)]);

    await leaf(h.command, ["tools", "set"])(["acme", "--enable", "web_search, calendar"], context({ yes: true }));

    const recap = h.err.join("");
    expect(recap).toContain("Enable: calendar.");
    expect(recap).toContain("Disable: crm.");
    expect(recap).toContain("Leave enabled: web_search.");
    expect(h.calls[1]).toMatchObject({ method: "PATCH", body: { enabled: ["web_search", "calendar"] } });
  });

  it("refuses a tool the agent does not offer", async () => {
    const h = harness([response(tools)]);

    await expect(leaf(h.command, ["tools", "set"])(["acme", "--enable", "typo"], context({ yes: true })))
      .rejects.toThrow(/no tool named: typo/);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("filters to the enabled selection on request", async () => {
    const h = harness([response(tools)]);

    await leaf(h.command, ["tools", "show"])(["acme", "--enabled-only"], context());

    expect(h.out.join("")).not.toContain("calendar");
    expect(h.out.join("")).toContain("web_search");
  });
});

describe("agent channels", () => {
  const channels = {
    channels: [{ channelType: "telegram", enabled: true, config: { botToken: "••••1234", chatId: "-100" } }],
  };

  it("prints config key names and never a stored value", async () => {
    const h = harness([response(channels)]);

    await leaf(h.command, ["channels", "show"])(["acme"], context());

    const table = h.out.join("");
    expect(table).toContain("botToken, chatId");
    expect(table).not.toContain("••••");
    expect(table).not.toContain("-100");
  });

  it("takes configuration from a payload and recaps keys only", async () => {
    const h = harness([response(channels), response({ channel: channels.channels[0] })], {
      readPayload: async () => JSON.stringify({ botToken: "real-secret" }),
    });

    await leaf(h.command, ["channels", "set"])(["acme", "telegram", "--file", "-"], context({ yes: true }));

    const recap = h.err.join("");
    expect(recap).toContain("Set config keys: botToken.");
    expect(recap).toContain("Keep unlisted stored keys: chatId.");
    expect(recap).not.toContain("real-secret");
    expect(h.calls[1]).toMatchObject({
      method: "PUT",
      path: "/api/instances/acme/channels/telegram",
      body: { config: { botToken: "real-secret" }, enabled: true },
    });
  });

  it("rejects a payload that is not a JSON object", async () => {
    const h = harness([], { readPayload: async () => "not json" });

    await expect(leaf(h.command, ["channels", "set"])(["acme", "telegram", "--file", "cfg.json"], context({ yes: true })))
      .rejects.toThrow(/cfg\.json is not valid JSON/);
  });

  it("requires --confirm with the channel type before removing it", async () => {
    const h = harness([]);

    await expect(leaf(h.command, ["channels", "remove"])(["acme", "telegram"], context({ yes: true })))
      .rejects.toThrow(/--confirm telegram is required/);
  });
});

describe("agent hooks", () => {
  const hooks = {
    hooks: [
      { id: "22222222-2222-4222-8222-222222222222", event: "preToolUse", actionType: "function", enabled: true, position: 0, timeoutMs: 10000 },
    ],
  };

  it("lists hooks as a table", async () => {
    const h = harness([response(hooks)]);

    await leaf(h.command, ["hooks", "show"])(["acme"], context());

    expect(h.out.join("")).toContain("preToolUse");
  });

  it("recaps each patched field against its previous value", async () => {
    const h = harness([response(hooks), response({ hook: hooks.hooks[0] })], {
      readPayload: async () => JSON.stringify({ enabled: false }),
    });

    await leaf(h.command, ["hooks", "update"])(["acme", hooks.hooks[0].id, "--file", "-"], context({ yes: true }));

    expect(h.err.join("")).toContain("Set enabled to false (was true).");
    expect(h.calls[1]).toMatchObject({ method: "PATCH", path: `/api/instances/acme/hooks/${hooks.hooks[0].id}`, body: { enabled: false } });
  });

  it("refuses to patch a hook the agent does not have", async () => {
    const h = harness([response(hooks)], { readPayload: async () => "{}" });

    await expect(leaf(h.command, ["hooks", "update"])(["acme", "33333333-3333-4333-8333-333333333333", "--file", "-"], context({ yes: true })))
      .rejects.toThrow(/has no hook 33333333/);
  });
});

describe("agent conversations", () => {
  const conversations = {
    conversations: [
      {
        conversationId: "conv-1",
        title: "Refund request",
        channel: "telegram",
        instanceId: "acme",
        messageCount: 4,
        totalTokens: 1200,
        totalCost: 0.02,
        updatedAt: "2026-07-20T10:00:00.000Z",
      },
    ],
    total: 1,
  };

  it("filters by the agent slug and validates --limit", async () => {
    const h = harness([response(conversations)]);

    await leaf(h.command, ["conversations", "list"])(["acme", "--limit", "10"], context());

    expect(h.calls[0]).toMatchObject({ path: "/api/conversations", query: { instanceId: "acme", limit: "10" }, workspaceId: "ws-1" });
    expect(h.out.join("")).toContain("Refund request");

    const bad = harness([]);
    await expect(leaf(bad.command, ["conversations", "list"])(["acme", "--limit", "0"], context()))
      .rejects.toThrow(/--limit needs a positive integer/);
  });

  it("emits both source bodies unchanged as a composite JSON object", async () => {
    const detail = { conversation: conversations.conversations[0] };
    const messages = { messages: [{ id: "m1", role: "user", content: "hi", createdAt: "2026-07-20T10:00:00.000Z" }] };
    const h = harness([response(detail), response(messages)]);

    await leaf(h.command, ["conversations", "show"])(["acme", "conv-1"], context({ json: true }));

    expect(h.out.join("")).toBe(`{"conversation":${JSON.stringify(detail)},"messages":${JSON.stringify(messages)}}\n`);
  });

  it("renders the detail and its messages when not asked for JSON", async () => {
    const detail = { conversation: conversations.conversations[0] };
    const messages = { messages: [{ id: "m1", role: "user", content: "line one\nline two", createdAt: null }] };
    const h = harness([response(detail), response(messages)]);

    await leaf(h.command, ["conversations", "show"])(["acme", "conv-1"], context());

    const text = h.out.join("");
    expect(text).toContain("conversationId:");
    // A multi-line message must not break the table's column alignment.
    expect(text).toContain("line one line two");
  });
});
