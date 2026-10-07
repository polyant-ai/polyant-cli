// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import { createAgentCommand, type AgentCommandDependencies } from "./agent.js";

/** The telephone voice channel: readiness and settings (engine 1.2.0-ee). */

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
  const agent = createAgentCommand({
    request: request as unknown as AgentCommandDependencies["request"],
    loadConfig: async () => CONFIG,
    env: { POLYANT_KEY_DEV: "pk_dev_secret" },
    io: {
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
    ...overrides,
  });
  return { agent, out, err, calls };
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


const payload = (body: unknown) => ({ readPayload: async () => JSON.stringify(body) });

const STATUS = {
  available: true,
  enabled: false,
  ready: false,
  webhookUrl: "https://polyant.example/webhooks/twilio/acme/voice",
  baseUrl: "https://polyant.example",
  signatures: "verified",
  locales: ["it-IT"],
  defaultLocale: "it-IT",
  secrets: { elevenlabs_api_key: "organization", deepgram_api_key: null },
  missingSecrets: ["deepgram_api_key"],
  missingFields: ["twilio.authToken"],
  configError: null,
  issues: [],
  checks: [{ id: "voice_secret_missing", severity: "broken", section: "channels", params: { key: "deepgram_api_key" } }],
};

const SETTINGS = {
  enabled: true,
  twilio: { phoneNumber: "+390212345678", authTokenSet: true },
  speech: { locale: "it-IT", voiceId: "v1", ttsModel: null, sttProvider: "deepgram", waitSound: false, ambience: false },
  judges: {},
  profile: {},
};

describe("agent channels voice status", () => {
  it("prints the webhook URL, what is missing, and where each key comes from", async () => {
    const h = harness([response(STATUS)]);

    await leaf(h.agent, ["channels", "voice", "status"])(["acme"], context());

    expect(h.calls[0].path).toBe("/api/instances/acme/channels/voice/status");
    const out = h.out.join("");
    expect(out).toContain("https://polyant.example/webhooks/twilio/acme/voice");
    expect(out).toMatch(/ready:\s+no/);
    expect(out).toMatch(/missing fields:\s+twilio\.authToken/);
    expect(out).toContain("elevenlabs_api_key organization, deepgram_api_key unset");
    expect(out).toMatch(/broken\s+voice_secret_missing/);
  });

  it("passes the engine's body through with --json", async () => {
    const h = harness([response(STATUS)]);

    await leaf(h.agent, ["channels", "voice", "status"])(["acme"], context({ json: true }));

    expect(JSON.parse(h.out.join(""))).toEqual(STATUS);
  });
});

describe("agent channels voice settings show", () => {
  it("prints JSON that settings set accepts, without the read-only token flag", async () => {
    const h = harness([response({ exists: true, configReadable: true, settings: SETTINGS, issues: [] })]);

    await leaf(h.agent, ["channels", "voice", "settings", "show"])(["acme"], context());

    expect(h.calls[0].path).toBe("/api/instances/acme/channels/voice/settings");
    const printed = JSON.parse(h.out.join(""));
    expect(printed.twilio).toEqual({ phoneNumber: "+390212345678" });
    expect(printed.speech.voiceId).toBe("v1");
    expect(h.err.join("")).toContain("Twilio Auth Token: set.");
  });

  it("says when the agent has no voice channel yet", async () => {
    const h = harness([response({ exists: false, configReadable: true, settings: { ...SETTINGS, enabled: false }, issues: [] })]);

    await leaf(h.agent, ["channels", "voice", "settings", "show"])(["acme"], context());

    expect(h.err.join("")).toContain("has no voice channel yet");
  });
});

describe("agent channels voice settings set", () => {
  const file = { ...SETTINGS, twilio: { phoneNumber: "+390212345678" } };

  it("validates, then replaces the settings", async () => {
    const h = harness([response({ valid: true, issues: [] }), response({ settings: SETTINGS })], payload(file));

    await leaf(h.agent, ["channels", "voice", "settings", "set"])(["acme", "--file", "voice.json"], context({ yes: true }));

    expect(h.calls[0]).toMatchObject({ method: "POST", path: "/api/instances/acme/channels/voice/settings/validate", body: file });
    expect(h.calls[1]).toMatchObject({ method: "PUT", path: "/api/instances/acme/channels/voice/settings", body: file });
    const recap = h.err.join("");
    expect(recap).toContain("Keep the stored Twilio Auth Token.");
    expect(recap).toContain("ElevenLabs characters");
  });

  it("saves nothing while the engine reports an issue", async () => {
    const issues = [{ field: "speech.locale", code: "unsupported_locale", message: "speech.locale en-GB has no language pack" }];
    const h = harness([response({ valid: false, issues })], payload(file));

    await expect(
      leaf(h.agent, ["channels", "voice", "settings", "set"])(["acme", "--file", "voice.json"], context({ yes: true })),
    ).rejects.toThrow(/1 issue\(s\). Nothing was saved/);
    expect(h.calls).toHaveLength(1);
    expect(h.err.join("")).toContain("speech.locale en-GB has no language pack");
  });

  it("checks the file on a dry run without writing", async () => {
    const h = harness([response({ valid: true, issues: [] })], payload(file));

    await leaf(h.agent, ["channels", "voice", "settings", "set"])(["acme", "--file", "voice.json"], context({ dryRun: true }));

    expect(h.calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("names a new Auth Token by its length, never its value", async () => {
    const secret = { ...file, twilio: { authToken: "tok_0123456789" } };
    const h = harness([response({ valid: true, issues: [] }), response({ settings: SETTINGS })], payload(secret));

    await leaf(h.agent, ["channels", "voice", "settings", "set"])(["acme", "--file", "-"], context({ yes: true }));

    const recap = h.err.join("");
    expect(recap).toContain("Replace the Twilio Auth Token: 14 characters from stdin.");
    expect(recap).not.toContain("tok_0123456789");
  });
});
