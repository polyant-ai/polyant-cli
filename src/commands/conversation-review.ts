// SPDX-License-Identifier: Apache-2.0
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writeCompositeJson, writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { call, expectArray, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";
import { requireSlug } from "../runtime/workspace.js";

/**
 * Reviewing one conversation after the fact (engine 1.3.6): a voice call's
 * recordings and what the voice module decided, one kept call as a test bundle,
 * and one turn's request path — every model call and hook run filed under a
 * message. All of them read the conversation, so they take `conversation:read`
 * and, like every `/api/conversations` route, the agent slug as `instanceId`.
 */

const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
const RECORDING_SID = /^RE[0-9a-fA-F]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why the engine could not list a conversation's recordings, in the words an operator acts on. */
const RECORDINGS_UNAVAILABLE: Record<string, string> = {
  not_voice: "this is not a voice conversation",
  no_channel: "the agent has no voice channel",
  no_account_sid:
    "the voice channel has no Twilio Account SID: set twilio.accountSid with `agent channels voice settings set`",
  no_auth_token: "the voice channel has no Twilio auth token",
  credentials_rejected: "Twilio rejected the voice channel's credentials",
  twilio_error: "Twilio did not answer; try again",
};

function conversationPath(id: string, rest: string): string {
  return `/api/conversations/${encodeURIComponent(id)}${rest}`;
}

/** `<slug> <conversationId> [<third>]`, each required and none a flag. */
function positionals(args: readonly string[], action: string, names: readonly string[]): string[] {
  const slug = requireSlug(args, `conversations ${action}`);
  const rest = names.map((name, index) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ConfigError(`polyant-cli agent conversations ${action} needs a ${name}.`);
    }
    return value;
  });
  return [slug, ...rest];
}

async function writeOut(deps: ServiceDependencies, path: string, data: string | Uint8Array): Promise<void> {
  if (deps.writeOutput === undefined) throw new ConfigError("This build cannot write files.");
  await deps.writeOutput(path, data);
  deps.io.stderr(`Wrote ${typeof data === "string" ? Buffer.byteLength(data) : data.byteLength} bytes to ${path}.\n`);
}

interface Recording {
  sid?: string;
  callSid?: string;
  status?: string;
  durationSeconds?: number | null;
  channels?: number;
  startTime?: string | null;
}

async function recordings(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const [slug, id] = positionals(args, "recordings", ["conversation id"]);
  const options = args.slice(2);
  assertKnown(options, { value: ["--audio", "--out"] }, "agent conversations recordings option");
  const audio = takeValue(options, "--audio");
  const out = takeValue(options, "--out");
  const scope = await scopeFor(deps, context, "read");
  const query = { instanceId: slug };

  if (audio !== undefined) {
    if (!RECORDING_SID.test(audio)) throw new ConfigError(`--audio takes a Twilio Recording SID (RE followed by 32 hex digits); got ${JSON.stringify(audio)}.`);
    // Audio on a terminal is noise, and on a pipe it is easy to lose: it goes to a named file.
    if (out === undefined || out === "-") throw new ConfigError("--audio needs --out <file>: the recording is WAV audio.");
    const res = await call(deps, scope, { path: conversationPath(id, `/recordings/${encodeURIComponent(audio)}/audio`), query, binary: true });
    return writeOut(deps, out, res.bytes ?? new Uint8Array());
  }
  if (out !== undefined) throw new ConfigError("--out writes a recording's audio; it needs --audio <recordingSid>.");

  const list = await call(deps, scope, { path: conversationPath(id, "/recordings"), query });
  const timelines = await call(deps, scope, { path: conversationPath(id, "/call-timelines"), query });
  if (wantsJson(context)) return writeCompositeJson(deps.io, { recordings: list.raw, callTimelines: timelines.raw });

  const result = (list.body ?? {}) as { status?: unknown; recordings?: unknown };
  if (result.status !== "ok") {
    const status = text(result.status);
    deps.io.stdout(`No recordings: ${RECORDINGS_UNAVAILABLE[status] ?? status} (${status}).\n`);
  } else {
    const rows = expectArray<Recording>(result.recordings, `GET ${conversationPath(id, "/recordings")}`);
    deps.io.stdout(
      `${renderTable({
        headers: ["RECORDING", "CALL", "STATUS", "SECONDS", "CHANNELS", "STARTED"],
        rows: rows.map((row) => [text(row.sid), text(row.callSid), text(row.status), text(row.durationSeconds), text(row.channels), text(row.startTime)]),
        emptyMessage: "Twilio holds no recording of this conversation's calls.",
      })}\n`,
    );
  }

  const kept = (timelines.body ?? {}) as { timelines?: unknown; labels?: unknown };
  const calls = Array.isArray(kept.timelines) ? (kept.timelines as { callSid?: string; startedAt?: string; events?: unknown[] }[]) : [];
  const labels = Array.isArray(kept.labels) ? kept.labels.length : 0;
  deps.io.stdout(
    `\n${renderTable({
      headers: ["KEPT CALL", "STARTED", "EVENTS"],
      rows: calls.map((row) => [text(row.callSid), text(row.startedAt), text(Array.isArray(row.events) ? row.events.length : undefined)]),
      emptyMessage: "No call timeline kept: the voice channel keeps one only with diagnostics.recordDecisions on.",
    })}\n`,
  );
  if (calls.length > 0) {
    deps.io.stderr(`${labels} reviewer label(s). \`agent conversations export-call\` writes one call whole; --json carries the timelines.\n`);
  }
}

async function exportCall(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const [slug, id, callSid] = positionals(args, "export-call", ["conversation id", "call SID"]);
  const options = args.slice(3);
  assertKnown(options, { value: ["--out"] }, "agent conversations export-call option");
  if (!CALL_SID.test(callSid)) throw new ConfigError(`The call SID is a Twilio Call SID (CA followed by 32 hex digits); got ${JSON.stringify(callSid)}.`);
  const out = takeValue(options, "--out");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    path: conversationPath(id, `/calls/${encodeURIComponent(callSid)}/export`),
    query: { instanceId: slug },
  });
  if (out === undefined || out === "-") return writeRawResponse(deps.io, res.raw);
  await writeOut(deps, out, res.raw);
}

interface ModelCall {
  id?: string;
  callType?: string;
  purpose?: string | null;
  originName?: string | null;
  provider?: string;
  model?: string;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  outcome?: string;
  errorKind?: string | null;
  exchangeCount?: number;
}

interface HookRun {
  name?: string;
  event?: string;
  durationMs?: number;
  success?: boolean;
  error?: string | null;
}

interface MessageDebug {
  debugPayload?: unknown;
  turn?: { channel?: string; streaming?: boolean } | null;
  summary?: { model?: string; provider?: string; cost?: { total?: number }; latency?: { totalMs?: number } } | null;
  path?: {
    turnStartedAt?: string | null;
    replySentAt?: string | null;
    deliveredText?: string | null;
    intermediateText?: string | null;
    modelCalls?: unknown;
    hookRuns?: unknown;
  };
}

async function debug(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const [slug, id, messageId] = positionals(args, "debug", ["conversation id", "message id"]);
  const options = args.slice(3);
  assertKnown(options, { value: ["--call"] }, "agent conversations debug option");
  if (!UUID.test(messageId)) throw new ConfigError(`The message id is a UUID (see \`agent conversations show --json\`); got ${JSON.stringify(messageId)}.`);
  const callId = takeValue(options, "--call");
  if (callId !== undefined && !UUID.test(callId)) throw new ConfigError(`--call takes a model call id, a UUID from the CALL column; got ${JSON.stringify(callId)}.`);
  const scope = await scopeFor(deps, context, "read");
  const query = { instanceId: slug };
  const base = `/messages/${encodeURIComponent(messageId)}/debug`;

  if (callId !== undefined) {
    const res = await call(deps, scope, { path: conversationPath(id, `${base}/calls/${encodeURIComponent(callId)}/exchanges`), query });
    if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);
    const exchanges = expectArray<{ stepIndex?: number; attempt?: number; status?: number | null; createdAt?: string }>(
      (res.body as { exchanges?: unknown } | null)?.exchanges,
      `GET ${conversationPath(id, `${base}/calls/${callId}/exchanges`)}`,
    );
    deps.io.stdout(
      `${renderTable({
        headers: ["STEP", "ATTEMPT", "HTTP", "AT"],
        rows: exchanges.map((row) => [text(row.stepIndex), text(row.attempt), text(row.status), text(row.createdAt)]),
        emptyMessage: "No exchange kept for this call: they are kept only while the agent's debugEnabled is on.",
      })}\n`,
    );
    if (exchanges.length > 0) deps.io.stderr("The requests and responses are whole prompts: read them with --json.\n");
    return;
  }

  const res = await call(deps, scope, { path: conversationPath(id, base), query });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);
  const body = (res.body ?? {}) as MessageDebug;
  const path = body.path ?? {};
  writePrettyResource(deps.io, [
    { label: "channel", value: text(body.turn?.channel) },
    { label: "streaming", value: body.turn === null || body.turn === undefined ? "-" : body.turn.streaming === true ? "yes" : "no" },
    { label: "turnStartedAt", value: text(path.turnStartedAt) },
    { label: "replySentAt", value: text(path.replySentAt) },
    { label: "model", value: body.summary ? `${text(body.summary.provider)}/${text(body.summary.model)}` : "-" },
    { label: "totalMs", value: text(body.summary?.latency?.totalMs) },
    { label: "costUsd", value: text(body.summary?.cost?.total) },
    { label: "intermediateText", value: text(path.intermediateText) },
    { label: "delivered", value: path.deliveredText === null || path.deliveredText === undefined ? "the reply as stored" : "a different text: see --json" },
    { label: "llmPayload", value: body.debugPayload === null || body.debugPayload === undefined ? "not captured (debugEnabled was off)" : "captured: see --json" },
  ]);
  const calls = Array.isArray(path.modelCalls) ? (path.modelCalls as ModelCall[]) : [];
  deps.io.stdout(
    `\n${renderTable({
      headers: ["CALL", "TYPE", "FOR", "MODEL", "MS", "IN", "OUT", "COST", "OUTCOME", "EXCHANGES"],
      rows: calls.map((row) => [
        text(row.id),
        text(row.callType),
        text(row.purpose ?? row.originName),
        `${text(row.provider)}/${text(row.model)}`,
        text(row.durationMs),
        text(row.promptTokens),
        text(row.completionTokens),
        text(row.costUsd),
        row.errorKind ? `${text(row.outcome)}: ${row.errorKind}` : text(row.outcome),
        text(row.exchangeCount),
      ]),
      emptyMessage: "No model call is filed under this message: it is the user's message, or a turn from before the request path existed.",
    })}\n`,
  );
  const hooks = Array.isArray(path.hookRuns) ? (path.hookRuns as HookRun[]) : [];
  if (hooks.length > 0) {
    deps.io.stdout(
      `\n${renderTable({
        headers: ["HOOK", "EVENT", "MS", "OK", "ERROR"],
        rows: hooks.map((row) => [text(row.name), text(row.event), text(row.durationMs), row.success ? "yes" : "NO", text(row.error)]),
      })}\n`,
    );
  }
  if (calls.some((row) => (row.exchangeCount ?? 0) > 0)) {
    deps.io.stderr(`Read a call's raw exchanges with --call <CALL>.\n`);
  }
}

export const conversationReviewLeaves: Record<string, Node> = {
  recordings: {
    summary: "a voice conversation's call recordings and kept call timelines",
    usage: `Usage: polyant-cli agent conversations recordings <slug> <conversationId>
       polyant-cli agent conversations recordings <slug> <conversationId> --audio <recordingSid> --out <file>

Lists the recordings Twilio holds of the conversation's calls, read through the
voice channel's Twilio account: the channel needs twilio.accountSid (\`agent
channels voice settings set\`). Any other conversation answers with the reason
there are none. Below them, the call timelines the voice module kept, which it
does only while the channel's diagnostics.recordDecisions is on.

--audio downloads one recording as WAV to --out; each download is audited.
Needs conversation:read and Polyant Enterprise 1.3.6.`,
    action: recordings,
  },
  "export-call": {
    summary: "one kept voice call as a single test bundle",
    usage: `Usage: polyant-cli agent conversations export-call <slug> <conversationId> <callSid> [--out <file>]

What the voice module recorded for the call, its messages and tool calls, its
labels, and its recordings' paths on this API, as one JSON file for the voice
lab. A call is exportable only when its timeline was kept (the channel's
diagnostics.recordDecisions); otherwise the engine answers 404. Each export is
audited, since it carries the caller's words. Needs conversation:read and
Polyant Enterprise 1.3.6.`,
    action: exportCall,
  },
  debug: {
    summary: "the request path of one turn: model calls, hook runs, timings",
    usage: `Usage: polyant-cli agent conversations debug <slug> <conversationId> <messageId>
       polyant-cli agent conversations debug <slug> <conversationId> <messageId> --call <callId>

Name the assistant message of the turn (ids from \`agent conversations show
--json\`). The table lists every model call and hook run filed under it, with
their timing, tokens, cost and outcome; --json adds the captured LLM request and
the step trace. --call reads one model call's raw exchanges with the provider,
kept only while the agent's debugEnabled is on and for
DEBUG_PAYLOAD_RETENTION_DAYS. Needs conversation:read and engine 1.3.6, OSS or Enterprise.`,
    action: debug,
  },
};
