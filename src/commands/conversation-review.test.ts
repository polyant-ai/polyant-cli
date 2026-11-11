// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ApiResponse, RequestOptions } from "../api/client.js";
import type { Command, CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import { ExitCode, RemoteError } from "../exit.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import type { AgentCommandDependencies } from "./agent.js";
import { createAgentCommand } from "./agent.js";

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" } },
  contexts: { dev: { target: "dev", org: "acme", workspace: "ws-1" } },
  defaultContext: "dev",
};

const CONVERSATION = "acme:voice:+39000";
const ENCODED = encodeURIComponent(CONVERSATION);
const CALL = `CA${"a".repeat(32)}`;
const RECORDING = `RE${"b".repeat(32)}`;
const MESSAGE = "755f82bd-947c-4dff-93e2-17095efd9668";
const MODEL_CALL = "dc1ef46a-d219-45a3-adad-84b2104508d9";

function response(body: unknown, status = 200): ApiResponse {
  return { status, raw: JSON.stringify(body), body };
}

function harness(responses: (ApiResponse | Error)[]) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RequestOptions[] = [];
  const written: { path: string; data: string | Uint8Array }[] = [];
  const queue = [...responses];
  const request = vi.fn(async (_target: unknown, opts: RequestOptions) => {
    calls.push(opts);
    const next = queue.shift();
    if (next === undefined) throw new Error(`Unexpected request: ${opts.method ?? "GET"} ${opts.path}`);
    if (next instanceof Error) throw next;
    return next;
  });
  const command = createAgentCommand({
    request: request as unknown as AgentCommandDependencies["request"],
    loadConfig: async () => CONFIG,
    env: { POLYANT_KEY_DEV: "pk_dev_secret" },
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
    writeOutput: async (path, data) => {
      written.push({ path, data });
    },
  });
  return { command, out, err, calls, written };
}

function context(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["agent"], global: { json: false, yes: false, dryRun: false, ...global } };
}

function leaf(command: Command, name: string) {
  const node = command.children?.conversations?.children?.[name];
  if (node?.run === undefined) throw new Error(`No such action: conversations ${name}`);
  return node.run.bind(node);
}

describe("agent conversations recordings", () => {
  it("reads the recordings and the kept timelines, with the agent slug as instanceId", async () => {
    const h = harness([
      response({ status: "ok", recordings: [{ sid: RECORDING, callSid: CALL, status: "completed", durationSeconds: 42, channels: 2, startTime: "2026-11-10T09:00:00Z" }] }),
      response({ timelines: [{ callSid: CALL, startedAt: "2026-11-10T09:00:00Z", events: [{}, {}], transcripts: [] }], labels: [{}] }),
    ]);

    await leaf(h.command, "recordings")(["acme", CONVERSATION], context());

    expect(h.calls[0]).toMatchObject({ path: `/api/conversations/${ENCODED}/recordings`, query: { instanceId: "acme" } });
    expect(h.calls[1]).toMatchObject({ path: `/api/conversations/${ENCODED}/call-timelines`, query: { instanceId: "acme" } });
    const text = h.out.join("");
    expect(text).toMatch(new RegExp(`${RECORDING}\\s+${CALL}\\s+completed\\s+42\\s+2`));
    expect(text).toMatch(new RegExp(`${CALL}\\s+2026-11-10T09:00:00Z\\s+2`));
  });

  // The engine's documented answer for any conversation that is not a call.
  it("says why there are none, in the operator's words", async () => {
    const h = harness([response({ status: "not_voice" }), response({ timelines: [], labels: [] })]);

    await leaf(h.command, "recordings")(["acme", "acme:web:1"], context());

    const text = h.out.join("");
    expect(text).toContain("No recordings: this is not a voice conversation (not_voice).");
    expect(text).toContain("diagnostics.recordDecisions");
  });

  it("names the missing Account SID setting", async () => {
    const h = harness([response({ status: "no_account_sid" }), response({ timelines: [], labels: [] })]);

    await leaf(h.command, "recordings")(["acme", CONVERSATION], context());

    expect(h.out.join("")).toContain("set twilio.accountSid with `agent channels voice settings set`");
  });

  it("joins both bodies unmodified with --json", async () => {
    const list = response({ status: "not_voice" });
    const kept = response({ timelines: [], labels: [] });
    const h = harness([list, kept]);

    await leaf(h.command, "recordings")(["acme", CONVERSATION], context({ json: true }));

    expect(h.out.join("")).toBe(`{"recordings":${list.raw},"callTimelines":${kept.raw}}\n`);
  });

  it("downloads one recording's audio as bytes to --out", async () => {
    const audio = new Uint8Array([1, 2, 3]);
    const h = harness([{ status: 200, raw: "", body: null, bytes: audio }]);

    await leaf(h.command, "recordings")(["acme", CONVERSATION, "--audio", RECORDING, "--out", "call.wav"], context());

    expect(h.calls[0]).toMatchObject({ path: `/api/conversations/${ENCODED}/recordings/${RECORDING}/audio`, binary: true });
    expect(h.written).toEqual([{ path: "call.wav", data: audio }]);
    expect(h.err.join("")).toContain("Wrote 3 bytes to call.wav.");
    expect(h.out.join("")).toBe("");
  });

  it("refuses --audio without a file, and a malformed recording SID, before sending", async () => {
    const h = harness([]);

    await expect(leaf(h.command, "recordings")(["acme", CONVERSATION, "--audio", RECORDING], context())).rejects.toThrow(/needs --out <file>/);
    await expect(leaf(h.command, "recordings")(["acme", CONVERSATION, "--audio", "RE1", "--out", "x.wav"], context())).rejects.toThrow(
      /Twilio Recording SID/,
    );
    expect(h.calls).toHaveLength(0);
  });
});

describe("agent conversations export-call", () => {
  it("prints the bundle byte for byte", async () => {
    const bundle = response({ version: 1, callSid: CALL, timeline: {} });
    const h = harness([bundle]);

    await leaf(h.command, "export-call")(["acme", CONVERSATION, CALL], context());

    expect(h.calls[0]).toMatchObject({ path: `/api/conversations/${ENCODED}/calls/${CALL}/export`, query: { instanceId: "acme" } });
    expect(h.out.join("")).toBe(bundle.raw);
  });

  it("writes the bundle to --out", async () => {
    const bundle = response({ version: 1 });
    const h = harness([bundle]);

    await leaf(h.command, "export-call")(["acme", CONVERSATION, CALL, "--out", "call.json"], context());

    expect(h.written).toEqual([{ path: "call.json", data: bundle.raw }]);
  });

  it("refuses a malformed call SID before sending", async () => {
    const h = harness([]);

    await expect(leaf(h.command, "export-call")(["acme", CONVERSATION, "CA12"], context())).rejects.toThrow(/Twilio Call SID/);
    expect(h.calls).toHaveLength(0);
  });

  it("passes the engine's 404 for a call it did not keep", async () => {
    const h = harness([new RemoteError(`No kept call ${CALL} in this conversation`, ExitCode.Config, 404)]);

    await expect(leaf(h.command, "export-call")(["acme", CONVERSATION, CALL], context())).rejects.toThrow(/No kept call/);
  });
});

describe("agent conversations debug", () => {
  const DEBUG = {
    debugPayload: { system: "…", messages: [], tools: [] },
    steps: [],
    content: "Hello",
    turn: { channel: "web", streaming: true, speechToText: null },
    summary: { model: "gpt-6.1-terra", provider: "openai", cost: { total: 0.000042 }, latency: { totalMs: 50 } },
    path: {
      turnStartedAt: "2026-11-11T11:59:32.807Z",
      replySentAt: "2026-11-11T11:59:32.857Z",
      deliveredText: null,
      intermediateText: null,
      modelCalls: [
        { id: MODEL_CALL, callType: "conversation", purpose: null, originName: null, provider: "openai", model: "gpt-6.1-terra", durationMs: 28, promptTokens: 12, completionTokens: 6, costUsd: 0.000042, outcome: "ok", errorKind: null, exchangeCount: 1 },
      ],
      hookRuns: [{ name: "audit", event: "afterResponse", durationMs: 3, success: false, error: "boom" }],
    },
  };

  it("renders the request path: the turn, each model call and each hook run", async () => {
    const h = harness([response(DEBUG)]);

    await leaf(h.command, "debug")(["acme", CONVERSATION, MESSAGE], context());

    expect(h.calls[0]).toMatchObject({ path: `/api/conversations/${ENCODED}/messages/${MESSAGE}/debug`, query: { instanceId: "acme" } });
    const text = h.out.join("");
    expect(text).toMatch(/channel:\s+web/);
    expect(text).toMatch(/llmPayload:\s+captured/);
    expect(text).toMatch(new RegExp(`${MODEL_CALL}\\s+conversation\\s+-\\s+openai/gpt-6.1-terra\\s+28\\s+12\\s+6`));
    expect(text).toMatch(/audit\s+afterResponse\s+3\s+NO\s+boom/);
    expect(h.err.join("")).toContain("--call <CALL>");
  });

  it("passes the body through with --json", async () => {
    const body = response(DEBUG);
    const h = harness([body]);

    await leaf(h.command, "debug")(["acme", CONVERSATION, MESSAGE], context({ json: true }));

    expect(h.out.join("")).toBe(body.raw);
  });

  it("reads one model call's exchanges with --call", async () => {
    const h = harness([response({ exchanges: [{ stepIndex: 0, attempt: 1, status: 200, request: {}, response: {}, createdAt: "2026-11-11T11:59:37Z" }] })]);

    await leaf(h.command, "debug")(["acme", CONVERSATION, MESSAGE, "--call", MODEL_CALL], context());

    expect(h.calls[0].path).toBe(`/api/conversations/${ENCODED}/messages/${MESSAGE}/debug/calls/${MODEL_CALL}/exchanges`);
    expect(h.out.join("")).toMatch(/0\s+1\s+200\s+2026-11-11T11:59:37Z/);
  });

  it("refuses ids that are not UUIDs before sending", async () => {
    const h = harness([]);

    await expect(leaf(h.command, "debug")(["acme", CONVERSATION, "m-1"], context())).rejects.toThrow(/message id is a UUID/);
    await expect(leaf(h.command, "debug")(["acme", CONVERSATION, MESSAGE, "--call", "c-1"], context())).rejects.toThrow(
      /--call takes a model call id/,
    );
    expect(h.calls).toHaveLength(0);
  });
});
