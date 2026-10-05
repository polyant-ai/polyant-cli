// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import type { RequestOptions, StreamEvent, StreamResponse } from "../api/client.js";
import type { CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import { ExitCode } from "../exit.js";
import type { GlobalOptions } from "../runtime/global-options.js";
import type { ServiceDependencies } from "../runtime/service.js";
import { chat, PLAYGROUND_PATH } from "./agent-chat.js";

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" } },
  contexts: { dev: { target: "dev", org: "acme", workspace: "general" } },
  defaultContext: "dev",
};

/** The frame names and payloads the engine's stream serializer emits. */
const TURN: [string, unknown][] = [
  ["step-start", { index: 0, stepType: "initial" }],
  ["reasoning-delta", { text: "weighing\nthe options" }],
  ["tool-call", { id: "call-1", name: "web_search", args: { q: "polyant" } }],
  ["tool-result", { id: "call-1", result: "ok" }],
  ["text-delta", { text: "Hello, " }],
  ["text-delta", { text: "world." }],
  ["step-finish", { index: 0, finishReason: "stop" }],
  ["done", { usage: { totalTokens: 42 }, conversationId: "assistant:web:api-5048619a" }],
];

function framesOf(pairs: [string, unknown][]): AsyncGenerator<StreamEvent> {
  return (async function* () {
    for (const [event, data] of pairs) yield { event, data: JSON.stringify(data) };
  })();
}

function harness(pairs: [string, unknown][] = TURN, overrides: Partial<ServiceDependencies> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: RequestOptions[] = [];
  const deps: ServiceDependencies = {
    request: async () => {
      throw new Error("chat must not use the non-streaming path");
    },
    requestStream: async (_target, opts): Promise<StreamResponse> => {
      calls.push(opts);
      return { status: 200, events: framesOf(pairs) };
    },
    loadConfig: async () => CONFIG,
    env: { POLYANT_KEY_DEV: "pk_dev_secret" },
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      input: { isTTY: false, readLine: async () => "" },
    },
    readPayload: async () => "from a file",
    readBytes: async () => new Uint8Array(),
    ...overrides,
  };
  return { deps, out, err, calls };
}

function context(global: Partial<GlobalOptions> = {}): CommandContext {
  return { path: ["agent", "chat"], global: { json: false, yes: false, dryRun: false, ...global } };
}

describe("agent chat", () => {
  it("posts one turn to the playground route and never to the public chat route", async () => {
    const h = harness();

    await chat(["acme", "--message", "hi"], context(), h.deps);

    expect(h.calls[0]).toMatchObject({
      method: "POST",
      path: PLAYGROUND_PATH("acme"),
      workspaceSlug: "general",
      // A turn can idle for minutes inside a tool call; a deadline would abort it.
      timeoutMs: 0,
      body: { model: "acme", stream: true, messages: [{ role: "user", content: "hi" }] },
    });
    expect(PLAYGROUND_PATH("acme")).toBe("/api/instances/acme/playground/chat/stream");
    expect(h.calls[0].path).not.toBe("/api/instances/acme/chat/stream");
  });

  it("streams reply text to stdout and every other frame to stderr", async () => {
    const h = harness();

    await chat(["acme", "--message", "hi"], context(), h.deps);

    // stdout is the answer alone, so a pipe receives nothing else.
    expect(h.out.join("")).toBe("Hello, world.\n");
    const progress = h.err.join("");
    expect(progress).toContain("step 0 (initial)");
    expect(progress).toContain("tool web_search");
    expect(progress).toContain('thinking: weighing the options');
    expect(progress).not.toContain("Hello");
  });

  // Verified against a real engine stream: `done` carries the conversation id,
  // which is what makes a one-shot turn followable.
  it("names the conversation the engine recorded the turn in", async () => {
    const h = harness();

    await chat(["acme", "--message", "hi"], context(), h.deps);

    expect(h.err.join("")).toContain("conversation assistant:web:api-5048619a");
  });

  it("emits JSON Lines of the original frames under --json", async () => {
    const h = harness();

    await chat(["acme", "--message", "hi"], context({ json: true }), h.deps);

    const lines = h.out.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(TURN.length);
    expect(JSON.parse(lines[0])).toEqual({ event: "step-start", data: { index: 0, stepType: "initial" } });
    expect(JSON.parse(lines[4])).toEqual({ event: "text-delta", data: { text: "Hello, " } });
    // Nothing is rendered to stderr in machine mode.
    expect(h.err.join("")).toBe("");
  });

  it("reads the message from a file or stdin", async () => {
    const h = harness(TURN, { readPayload: async (source) => `read from ${source}` });

    await chat(["acme", "--file", "-"], context(), h.deps);

    expect(h.calls[0].body).toMatchObject({ messages: [{ role: "user", content: "read from -" }] });
  });

  it("refuses an empty message rather than sending a turn", async () => {
    const h = harness(TURN, { readPayload: async () => "   \n" });

    await expect(chat(["acme", "--file", "msg.txt"], context(), h.deps)).rejects.toThrow(/contained no message/);
    expect(h.calls).toHaveLength(0);
  });

  it("requires a slug and a message, and rejects an unknown option", async () => {
    const h = harness();

    await expect(chat([], context(), h.deps)).rejects.toThrow(/needs an agent slug/);
    await expect(chat(["acme"], context(), h.deps)).rejects.toThrow(/--message <text> or --file/);
    await expect(chat(["acme", "--message", "hi", "--stream"], context(), h.deps)).rejects.toThrow(
      /Unknown agent chat option --stream/,
    );
    await expect(chat(["acme", "--message", "hi", "--file", "x"], context(), h.deps)).rejects.toThrow(
      /only one of --message or --file/,
    );
  });

  it("forwards a conversation id and a temperature override", async () => {
    const h = harness();

    await chat(["acme", "--message", "hi", "--conversation", "conv-1", "--temperature", "0.2"], context(), h.deps);

    expect(h.calls[0].body).toMatchObject({ chat_id: "conv-1", temperature: 0.2 });
  });

  it("rejects a temperature that is not a number", async () => {
    const h = harness();

    await expect(chat(["acme", "--message", "hi", "--temperature", "warm"], context(), h.deps)).rejects.toThrow(
      /--temperature needs a number/,
    );
  });

  // An error frame means the turn never completed: neither success nor a mere
  // difference, so it must map to the remote code.
  it("maps an error frame to a remote failure", async () => {
    const h = harness([
      ["step-start", { index: 0, stepType: "initial" }],
      ["error", { message: "upstream provider refused" }],
      ["done", {}],
    ]);

    const failure = chat(["acme", "--message", "hi"], context(), h.deps);
    await expect(failure).rejects.toThrow(/upstream provider refused/);
    await expect(failure).rejects.toMatchObject({ code: ExitCode.Remote });
  });

  it("stops at the done frame and ignores anything after it", async () => {
    const h = harness([
      ["text-delta", { text: "first" }],
      ["done", {}],
      ["text-delta", { text: " second" }],
    ]);

    await chat(["acme", "--message", "hi"], context(), h.deps);

    expect(h.out.join("")).toBe("first\n");
  });

  describe("--expect", () => {
    it("exits 0 when the reply contains the expected text", async () => {
      const h = harness();

      await expect(chat(["acme", "--message", "hi", "--expect", "world"], context(), h.deps)).resolves.toBeUndefined();
    });

    // Exit 1 is "a difference or a failed assertion": the tool worked, the
    // scenario did not hold. It must not be confused with a transport failure.
    it("exits 1 when the reply does not contain the expected text", async () => {
      const h = harness();

      const failure = chat(["acme", "--message", "hi", "--expect", "goodbye"], context(), h.deps);
      await expect(failure).rejects.toMatchObject({ code: ExitCode.Difference });
      await expect(failure).rejects.toThrow(/does not contain "goodbye"/);
    });

    it("asserts on the assembled reply, not on one delta", async () => {
      const h = harness([
        ["text-delta", { text: "Hel" }],
        ["text-delta", { text: "lo" }],
        ["done", {}],
      ]);

      await expect(chat(["acme", "--message", "hi", "--expect", "Hello"], context(), h.deps)).resolves.toBeUndefined();
    });
  });

  it("keeps an unparsable frame visible instead of dropping it", async () => {
    const h = harness();
    const broken = {
      ...h.deps,
      requestStream: async (): Promise<StreamResponse> => ({
        status: 200,
        events: (async function* () {
          yield { event: "text-delta", data: "not json" };
          yield { event: "done", data: "{}" };
        })(),
      }),
    };

    await chat(["acme", "--message", "hi"], context(), broken);

    expect(h.err.join("")).toContain("unparsable frame: not json");
  });

  it("does not demand an explicit workspace, since a playground turn changes no configuration", async () => {
    const request = vi.fn();
    const h = harness(TURN, { request, loadConfig: async () => ({ default: "dev", targets: CONFIG.targets }) });

    await chat(["acme", "--message", "hi"], context(), h.deps);

    expect(h.calls[0].workspaceSlug).toBeUndefined();
    expect(h.err.join("")).toContain("no workspace selected");
  });
});
