// SPDX-License-Identifier: Apache-2.0
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { call, expectArray, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";
import { agentPath, preflight, reportWrite, requireSlug } from "../runtime/workspace.js";
import { parseObject } from "./governance.js";

/**
 * The telephone voice channel (Enterprise, engine 1.2.0-ee).
 *
 * The channel is stored as an ordinary channel row, so `channels show/set/remove`
 * reach it, but its stored shape packs the profile into a JSON string and the
 * generic write merges keys without validating the profile. These commands use
 * the routes the panel uses instead: a settings object read and written whole,
 * checked field by field before anything is saved, and a readiness report that
 * names what a call still needs.
 */

interface VoiceIssue {
  field?: string;
  message?: string;
}

interface VoiceCheck {
  id?: string;
  severity?: string;
  params?: unknown;
}

/**
 * One credential role a call can use (engine 1.2.0-ee): the connection bound to
 * it in the agent's provider roles, not a key among the agent's secrets.
 */
interface VoiceRoleState {
  role?: string;
  inUse?: boolean;
  required?: boolean;
  requiredProvider?: string;
  ready?: boolean;
  problem?: string | null;
  message?: string | null;
}

interface VoiceStatus {
  available?: boolean;
  enabled?: boolean;
  ready?: boolean;
  webhookUrl?: string;
  baseUrl?: string;
  signatures?: string;
  locales?: string[];
  defaultLocale?: string;
  roles?: unknown;
  /** Roles in use that a call cannot start without, and that cannot run now. */
  missingRoles?: string[];
  missingFields?: string[];
  configError?: string | null;
  issues?: unknown;
  checks?: unknown;
}

interface VoiceSettingsBody {
  exists?: boolean;
  configReadable?: boolean;
  settings?: Record<string, unknown> & { twilio?: Record<string, unknown> };
  issues?: unknown;
}

function voicePath(slug: string, rest: string): string {
  return agentPath(slug, `/channels/voice/${rest}`);
}

function yesNo(value: unknown): string {
  return value === true ? "yes" : value === false ? "no" : "-";
}

function list(values: readonly string[] | undefined): string {
  return values === undefined || values.length === 0 ? "(none)" : values.join(", ");
}

function issueTable(issues: readonly VoiceIssue[]): string {
  return renderTable({
    headers: ["FIELD", "ISSUE"],
    rows: issues.map((issue) => [text(issue.field), text(issue.message)]),
    emptyMessage: "No issues.",
  });
}

async function voiceStatus(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "channels voice status");
  assertKnown(args.slice(1), {}, "agent channels voice status option");
  const scope = await scopeFor(deps, context, "read");
  const path = voicePath(slug, "status");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as VoiceStatus;
  const issues = expectArray<VoiceIssue>(body.issues, `GET ${path}`);
  const checks = expectArray<VoiceCheck>(body.checks, `GET ${path}`);
  const roles = expectArray<VoiceRoleState>(body.roles, `GET ${path}`);
  writePrettyResource(deps.io, [
    { label: "ready", value: yesNo(body.ready) },
    { label: "enabled", value: yesNo(body.enabled) },
    // false: this engine runs without the voice package, and no setting changes that.
    { label: "available", value: yesNo(body.available) },
    { label: "webhook url", value: text(body.webhookUrl) },
    { label: "signatures", value: text(body.signatures) },
    { label: "locales", value: `${list(body.locales)} (default ${text(body.defaultLocale)})` },
    { label: "missing fields", value: list(body.missingFields) },
    { label: "missing roles", value: list(body.missingRoles) },
    { label: "config error", value: text(body.configError) },
  ]);
  // Which roles the saved settings use, on which provider, and whether the
  // connection bound to each can run — never a credential.
  deps.io.stdout(
    `\n${renderTable({
      headers: ["ROLE", "IN USE", "REQUIRED", "PROVIDER", "READY"],
      rows: roles.map((role) => [text(role.role), yesNo(role.inUse), yesNo(role.required), text(role.requiredProvider), yesNo(role.ready)]),
      emptyMessage: "The engine reported no voice roles.",
    })}\n`,
  );
  const problems = roles.filter((role) => role.inUse === true && role.ready === false);
  if (problems.length > 0) {
    deps.io.stdout(`\n${problems.map((role) => `${text(role.role)}: ${text(role.message ?? role.problem)}`).join("\n")}\n`);
  }
  if (issues.length > 0) deps.io.stdout(`\n${issueTable(issues)}\n`);
  // Computed as if the channel were on, so a disabled channel still lists what a call would need.
  deps.io.stdout(
    `\n${renderTable({
      headers: ["SEVERITY", "CHECK", "PARAMS"],
      rows: checks.map((check) => [
        text(check.severity),
        text(check.id),
        check.params === undefined ? "-" : JSON.stringify(check.params),
      ]),
      emptyMessage: "No voice checks: a call has what it needs.",
    })}\n`,
  );
}

async function settingsShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "channels voice settings show");
  assertKnown(args.slice(1), {}, "agent channels voice settings show option");
  const scope = await scopeFor(deps, context, "read");
  const path = voicePath(slug, "settings");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as VoiceSettingsBody;
  if (body.settings === undefined) throw new ConfigError(`GET ${path} did not return settings.`);
  if (body.exists === false) deps.io.stderr(`Agent ${slug} has no voice channel yet; these are the defaults.\n`);
  if (body.configReadable === false) {
    deps.io.stderr("The stored voice configuration cannot be decrypted (a rotated ENCRYPTION_KEY); what follows is empty.\n");
  }
  const { authTokenSet, ...twilio } = body.settings.twilio ?? {};
  deps.io.stderr(`Twilio Auth Token: ${authTokenSet === true ? "set" : "not set"}.\n`);
  const issues = expectArray<VoiceIssue>(body.issues ?? [], `GET ${path}`);
  if (issues.length > 0) deps.io.stderr(`The stored configuration no longer validates:\n${issueTable(issues)}\n`);
  // stdout is exactly what `settings set` accepts: the read-only authTokenSet
  // flag is left out, so the output can be versioned and sent back unchanged.
  deps.io.stdout(`${JSON.stringify({ ...body.settings, twilio }, null, 2)}\n`);
}

/**
 * What the file does to the Auth Token, by the engine's rule: absent, empty or
 * masked keeps the stored one, null clears it, anything else replaces it.
 */
function authTokenChange(settings: Record<string, unknown>, source: string): string {
  const twilio = settings.twilio;
  const token = twilio !== null && typeof twilio === "object" ? (twilio as Record<string, unknown>).authToken : undefined;
  if (token === null) return "Clear the Twilio Auth Token: calls cannot start until one is set again.";
  if (typeof token === "string" && token.trim() !== "" && !token.startsWith("••••")) {
    return `Replace the Twilio Auth Token: ${token.trim().length} characters from ${source}.`;
  }
  return "Keep the stored Twilio Auth Token.";
}

async function settingsSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "channels voice settings set");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file"] }, "agent channels voice settings set option");
  const file = takeValue(options, "--file");
  if (file === undefined) {
    throw new ConfigError("polyant-cli agent channels voice settings set needs --file <path> (or --file - for stdin).");
  }
  const source = file === "-" ? "stdin" : file;
  const settings = parseObject(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);

  const scope = await scopeFor(deps, context);
  // The engine's own check, field by field and against the language pack, before
  // the recap: a dry run then says whether the file would be accepted.
  const checked = await call(deps, scope, { method: "POST", path: voicePath(slug, "settings/validate"), body: settings });
  const verdict = (checked.body ?? {}) as { valid?: boolean; issues?: unknown };
  if (verdict.valid !== true) {
    const issues = expectArray<VoiceIssue>(verdict.issues ?? [], `POST ${voicePath(slug, "settings/validate")}`);
    deps.io.stderr(`${issueTable(issues)}\n`);
    throw new ConfigError(`${source} is not a valid voice configuration: ${issues.length} issue(s). Nothing was saved.`);
  }

  const enabled = settings.enabled === true;
  const plan = {
    title: `Set the voice channel of ${slug}`,
    changes: [
      enabled
        ? "Turn the voice channel on: the agent answers calls to its Twilio number."
        : "Leave the voice channel off: the agent does not answer calls.",
      "The file replaces the whole voice configuration: a field it leaves out takes its default.",
      authTokenChange(settings, source),
      // The engine synthesizes the agent's fixed phrases and wait lines on every
      // save of an enabled channel, and that is billed by ElevenLabs.
      ...(enabled ? ["Saving prepares the agent's fixed phrases and wait lines again, spending ElevenLabs characters."] : []),
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PUT", path: voicePath(slug, "settings"), body: settings });
  reportWrite(deps, context, res, `Set the voice channel of ${slug}.`);
}

/** The `agent channels voice` subtree. */
export const agentVoiceFamily: Record<string, Node> = {
  status: {
    summary: "what a call to the agent still needs, and the webhook URL to paste into Twilio",
    usage: `Usage: polyant-cli agent channels voice status <slug>

The "A call comes in" URL of the agent's Twilio number, whether a call can start,
the fields still missing, and the credential roles the saved settings use:
voice_tts, voice_stt, voice_turn_detection, voice_text_model and the optional
voice_decisions, each with the provider it must be on and whether the connection
bound to it can run. A role in use that cannot is followed by the engine's
reason. Bind them with \`agent provider-roles bind\`: since engine 1.2.0-ee the
voice reads no key from the agent's secrets. The checks are computed as if the
channel were on.
"available: no" means this engine runs without the voice package. A localhost
webhook URL means the platform Base URL is not set; Twilio needs a public HTTPS
address that also carries WebSockets. Enterprise only, engine 1.2.0-ee or later.`,
    action: voiceStatus,
  },
  settings: {
    show: {
      summary: "print the voice channel's settings as the JSON that settings set takes",
      usage: `Usage: polyant-cli agent channels voice settings show <slug>

stdout is the settings object — enabled, twilio, speech, judges, profile — ready
to version and send back with \`settings set\`. Whether the Twilio Auth Token is
stored goes to stderr; the token itself is never returned. With --json the
engine's response is printed unchanged.`,
      action: settingsShow,
    },
    set: {
      summary: "replace the voice channel's settings from a JSON file or stdin",
      usage: `Usage: polyant-cli agent channels voice settings set <slug> --file <path|->

The file replaces the whole configuration: a field it leaves out takes its
default. It is checked by the engine first, every issue at once, and nothing is
saved while one remains — --dry-run runs that check too.

twilio.authToken: absent, empty or masked keeps the stored token, null clears
it. Do not commit it: set it in the panel, or pipe a one-off file through
--file -. Saving an enabled channel synthesizes the agent's fixed phrases and
wait lines again, which spends ElevenLabs characters. Needs channel:write.`,
      action: settingsSet,
      mutates: true,
    },
  },
};
