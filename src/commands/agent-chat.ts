// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { Command, CommandContext } from "../command.js";
import { CliError, ConfigError, ExitCode, RemoteError } from "../exit.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { callStream, scopeFor, type ServiceDependencies } from "../runtime/service.js";

/**
 * The management-key playground stream. It is deliberately NOT
 * `/api/instances/:slug/chat/stream`: that route is `@Public()`, authenticates a
 * per-instance bearer key, and returns early when the agent has `authEnabled`
 * false. A management console must not hold a runtime key, and must not depend on
 * an agent being open.
 */
export const PLAYGROUND_PATH = (slug: string) => `/api/instances/${encodeURIComponent(slug)}/playground/chat/stream`;

/** The frame names the engine's stream serializer emits. */
type EventName =
  | "step-start"
  | "step-finish"
  | "reasoning-delta"
  | "text-delta"
  | "tool-call"
  | "tool-result"
  | "hook-execution"
  | "error"
  | "done";

interface Turn {
  /** Everything the agent said, in order, as it arrived. */
  readonly text: string;
  readonly toolCalls: readonly string[];
  /** The conversation the engine recorded the turn in, when `done` reports it. */
  readonly conversationId?: string;
}

function describe(name: string, payload: Record<string, unknown>): string | undefined {
  switch (name as EventName) {
    case "step-start":
      return `· step ${payload.index} (${payload.stepType})`;
    case "step-finish":
      return `· step ${payload.index} finished (${payload.finishReason})`;
    case "reasoning-delta":
      return typeof payload.text === "string" ? `· thinking: ${payload.text.replaceAll("\n", " ")}` : undefined;
    case "tool-call":
      return `· tool ${String(payload.name)} ${JSON.stringify(payload.args ?? {})}`;
    case "tool-result":
      return `· tool ${String(payload.id)} returned`;
    case "hook-execution":
      return `· hook ${JSON.stringify(payload)}`;
    default:
      return undefined;
  }
}

/**
 * Consumes one streamed turn. Reply text goes to stdout as it arrives so a pipe
 * sees the answer alone; every other frame is progress and belongs on stderr.
 */
async function consume(
  deps: ServiceDependencies,
  events: AsyncIterable<{ event?: string; data: string }>,
  json: boolean,
): Promise<Turn> {
  let text = "";
  let conversationId: string | undefined;
  const toolCalls: string[] = [];

  for await (const frame of events) {
    if (json) {
      // JSON Lines of the original payloads, each tagged with its frame name, so
      // a consumer reads the stream incrementally without re-deriving the shape.
      deps.io.stdout(`${JSON.stringify({ event: frame.event ?? null, data: rawOrText(frame.data) })}\n`);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      if (!json) deps.io.stderr(`· unparsable frame: ${frame.data}\n`);
      continue;
    }

    const name = frame.event ?? "";
    if (name === "error") {
      const message = typeof payload.message === "string" ? payload.message : frame.data;
      // A remote refusal mid-stream is a remote failure, not a difference: the
      // turn never completed, so it must not exit 0 or 1.
      throw new RemoteError(`agent chat failed: ${message}`, ExitCode.Remote);
    }
    if (name === "done") {
      // The engine reports the conversation it recorded the turn in. Naming it
      // turns a one-shot reply into something the operator can follow up on with
      // `agent conversations show`, or continue with --conversation.
      if (typeof payload.conversationId === "string") conversationId = payload.conversationId;
      break;
    }
    if (name === "text-delta" && typeof payload.text === "string") {
      text += payload.text;
      if (!json) deps.io.stdout(payload.text);
      continue;
    }
    if (name === "tool-call" && typeof payload.name === "string") toolCalls.push(payload.name);
    if (!json) {
      const line = describe(name, payload);
      if (line !== undefined) deps.io.stderr(`${line}\n`);
    }
  }

  if (!json && text.length > 0 && !text.endsWith("\n")) deps.io.stdout("\n");
  if (!json && conversationId !== undefined) deps.io.stderr(`· conversation ${conversationId}\n`);
  return { text, toolCalls, ...(conversationId === undefined ? {} : { conversationId }) };
}

/** Keeps an unparsable frame in the JSON Lines output instead of dropping it. */
function rawOrText(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

const FLAGS = { value: ["--message", "--file", "--expect", "--temperature", "--conversation"] } as const;

async function readMessage(args: readonly string[], deps: ServiceDependencies): Promise<string> {
  const message = takeValue(args, "--message");
  const file = takeValue(args, "--file");
  if (message !== undefined && file !== undefined) throw new ConfigError("Use only one of --message or --file.");
  if (message !== undefined) return message;
  if (file !== undefined) {
    const text = (await deps.readPayload(file)).trim();
    if (text.length === 0) throw new ConfigError(`${file === "-" ? "stdin" : file} contained no message.`);
    return text;
  }
  throw new ConfigError("polyant-cli agent chat needs --message <text> or --file <path|->.");
}

function temperature(args: readonly string[]): Record<string, number> {
  const raw = takeValue(args, "--temperature");
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ConfigError("--temperature needs a number.");
  return { temperature: value };
}

export async function chat(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = args[0];
  if (slug === undefined || slug.startsWith("--")) throw new ConfigError("polyant-cli agent chat needs an agent slug.");
  const options = args.slice(1);
  assertKnown(options, FLAGS, "agent chat option");

  const message = await readMessage(options, deps);
  const expected = takeValue(options, "--expect");
  const conversation = takeValue(options, "--conversation");
  const json = context?.global.json === true;

  // A read: chatting does not change the agent's configuration, and requiring an
  // explicit workspace for a playground turn would make it unusable by default.
  const scope = await scopeFor(deps, context, "read");
  const stream = await callStream(deps, scope, {
    method: "POST",
    path: PLAYGROUND_PATH(slug),
    body: {
      // The engine forces `model` to the slug and `stream` to true; sending them
      // keeps the payload valid against the documented request shape.
      model: slug,
      stream: true,
      messages: [{ role: "user", content: message }],
      ...temperature(options),
      ...(conversation === undefined ? {} : { chat_id: conversation }),
    },
    // A turn can run for minutes with no output while a tool call is in flight.
    timeoutMs: 0,
  });

  const turn = await consume(deps, stream.events, json);

  if (expected !== undefined && !turn.text.includes(expected)) {
    // Exit 1 is the contract's "difference or failed assertion": the tool worked,
    // the scenario did not hold.
    throw new CliError(
      `assertion failed: the reply does not contain ${JSON.stringify(expected)}.`,
      ExitCode.Difference,
    );
  }
}

export const CHAT_USAGE = `Usage: polyant-cli agent chat <slug> (--message <text> | --file <path|->) [options]

Sends one turn to the agent's playground with the management key and streams the
reply. Reply text goes to stdout as it arrives; steps, reasoning and tool calls
go to stderr, so a pipe receives the answer alone.

Options:
  --message <text>       the user message
  --file <path|->        read the user message from a file, or stdin
  --expect <text>        exit 1 unless the reply contains this text
  --conversation <id>    reuse a conversation id across turns
  --temperature <n>      override the agent's temperature for this turn
  --json                 emit JSON Lines: one engine frame per line, unmodified

This uses the management playground route, never the per-instance chat route:
the CLI holds no runtime agent key and must not depend on an agent having
authEnabled false.`;

export function chatCommand(deps: ServiceDependencies): Command {
  return {
    summary: "send one turn to an agent and stream the reply",
    usage: CHAT_USAGE,
    run: (args, context) => chat(args, context, deps),
  };
}
