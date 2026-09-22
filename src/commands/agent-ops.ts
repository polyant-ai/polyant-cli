// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { CommandContext } from "../command.js";
import type { ScheduledTask, ScheduledTasksResponse } from "../api/types.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import {
  call,
  expectArray,
  maybe,
  positiveInteger,
  scopeFor,
  text,
  wantsJson,
  type ServiceDependencies,
} from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";
import { agentPath, preflight, reportWrite, requireSecond, requireSlug } from "../runtime/workspace.js";
import { parseObject } from "./governance.js";

/**
 * The agent surfaces the engine grew after the first pass of this CLI: skills,
 * knowledge, scheduled tasks, event sources, retention, compliance, governance
 * assignment, and the export/import pair.
 *
 * Two conventions hold throughout, both inherited rather than invented here:
 * a structured body arrives as `--file <path|->` rather than as a fan of flags
 * (an inline payload lands in shell history and in `ps`, and the engine's shapes
 * are nested), and a response whose value IS its structure passes through
 * unmodified rather than being flattened into a table that drops half of it.
 */
async function readPayloadObject(deps: ServiceDependencies, file: string): Promise<Record<string, unknown>> {
  return parseObject(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);
}

function requireFile(options: readonly string[], action: string): string {
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError(`polyant-cli agent ${action} needs --file <path> (or --file - for stdin).`);
  return file;
}

function paging(args: readonly string[]): Record<string, string> {
  return {
    ...maybe("limit", positiveInteger(takeValue(args, "--limit"), "--limit")),
    ...maybe("offset", positiveInteger(takeValue(args, "--offset"), "--offset")),
  };
}

// --- skills -----------------------------------------------------------------

interface AgentSkillRow {
  name: string;
  description: string;
  enabled: boolean;
  autoLoad: boolean;
  envConfigured: boolean;
  currentVersion: string | null;
  hasUpdate: boolean;
  requiredEnv?: { name: string }[];
}

async function skillsShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "skills show");
  assertKnown(args.slice(1), { boolean: ["--enabled-only"] }, "agent skills show option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/skills");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const all = expectArray<AgentSkillRow>((res.body as { skills?: unknown } | null)?.skills, `GET ${path}`);
  const skills = args.includes("--enabled-only") ? all.filter((skill) => skill.enabled) : all;
  deps.io.stdout(
    `${renderTable({
      headers: ["NAME", "ENABLED", "AUTOLOAD", "VERSION", "UPDATE", "ENV OK"],
      rows: skills.map((skill) => [
        text(skill.name),
        skill.enabled ? "yes" : "no",
        skill.autoLoad ? "yes" : "no",
        text(skill.currentVersion),
        skill.hasUpdate ? "yes" : "no",
        skill.envConfigured ? "yes" : "no",
      ]),
      emptyMessage: `The catalog offers ${slug} no skills.`,
    })}\n`,
  );
}

async function skillsSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "skills set");
  const options = args.slice(1);
  assertKnown(options, { value: ["--enable", "--confirm"], boolean: ["--none"] }, "agent skills set option");
  const none = options.includes("--none");
  const list = takeValue(options, "--enable");
  if (none === (list !== undefined)) {
    throw new ConfigError("polyant-cli agent skills set needs either --enable <name,name> or --none.");
  }
  const enabled = none ? [] : (list ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (!none && enabled.length === 0) throw new ConfigError("--enable needs at least one skill name; use --none to disable every skill.");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Set ${slug}'s enabled skills`,
    changes: [
      // The engine REPLACES the selection, so an omitted skill is a disabled one.
      // Saying "replace" rather than "enable" is the difference between a recap
      // that describes the write and one that hides half of it.
      none ? "Disable every skill." : `Replace the selection with: ${enabled.join(", ")}. Anything not listed is disabled.`,
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PATCH", path: agentPath(slug, "/skills"), body: { enabled } });
  reportWrite(deps, context, res, none ? `Disabled every skill on ${slug}.` : `Enabled ${enabled.length} skill(s) on ${slug}.`);
}

async function skillsAutoLoad(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "skills autoload");
  const name = requireSecond(args, "skills autoload", "skill name");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"], boolean: ["--on", "--off"] }, "agent skills autoload option");
  const on = options.includes("--on");
  if (on === options.includes("--off")) throw new ConfigError("polyant-cli agent skills autoload needs --on or --off.");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `${on ? "Auto-load" : "Stop auto-loading"} ${name} on ${slug}`,
    changes: [on ? `Load ${name} into every turn instead of on demand.` : `Load ${name} only when a turn calls for it.`],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "POST",
    path: agentPath(slug, `/skills/${encodeURIComponent(name)}/auto-load`),
    body: { autoLoad: on },
  });
  reportWrite(deps, context, res, `Set ${name} auto-load ${on ? "on" : "off"} for ${slug}.`);
}

async function skillsUpgrade(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "skills upgrade");
  const name = requireSecond(args, "skills upgrade", "skill name");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent skills upgrade option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Upgrade ${name} on ${slug}`,
    changes: [`Move ${slug} to the catalog's current version of ${name}.`, "Reversible with `agent skills rollback`."],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: agentPath(slug, `/skills/${encodeURIComponent(name)}/upgrade`) });
  reportWrite(deps, context, res, `Upgraded ${name} on ${slug}.`);
}

async function skillsRollback(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "skills rollback");
  const name = requireSecond(args, "skills rollback", "skill name");
  const options = args.slice(2);
  assertKnown(options, { value: ["--version-id", "--confirm"] }, "agent skills rollback option");
  const versionId = takeValue(options, "--version-id");
  if (versionId === undefined) {
    throw new ConfigError('polyant-cli agent skills rollback needs --version-id <id>. Run "polyant-cli skill versions <name>" for the ids.');
  }

  const scope = await scopeFor(deps, context);
  const plan = { title: `Roll ${name} back on ${slug}`, changes: [`Pin ${slug} to version ${versionId} of ${name}.`] };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "POST",
    path: agentPath(slug, `/skills/${encodeURIComponent(name)}/rollback`),
    body: { versionId },
  });
  reportWrite(deps, context, res, `Rolled ${name} back to ${versionId} on ${slug}.`);
}

async function skillsEnvShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "skills env show");
  const name = requireSecond(args, "skills env show", "skill name");
  assertKnown(args.slice(2), {}, "agent skills env show option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, `/skills/${encodeURIComponent(name)}/env`);
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const env = expectArray<{ key: string; sensitive?: boolean; value?: string | null }>(
    (res.body as { env?: unknown } | null)?.env,
    `GET ${path}`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["KEY", "SENSITIVE", "SET"],
      rows: env.map((entry) => [
        text(entry.key),
        entry.sensitive === true ? "yes" : "no",
        entry.value === null || entry.value === undefined || entry.value === "" ? "no" : "yes",
      ]),
      emptyMessage: `Skill ${name} declares no environment on ${slug}.`,
    })}\n`,
  );
}

async function skillsEnvSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "skills env set");
  const name = requireSecond(args, "skills env set", "skill name");
  const options = args.slice(2);
  assertKnown(options, { value: ["--key", "--file", "--confirm"], boolean: ["--sensitive"] }, "agent skills env set option");
  const key = takeValue(options, "--key");
  if (key === undefined) throw new ConfigError("polyant-cli agent skills env set needs --key <name>.");
  const file = requireFile(options, "skills env set");
  const value = (await deps.readPayload(file)).trim();
  if (value.length === 0) throw new ConfigError(`${file === "-" ? "stdin" : file} contained no value.`);
  const sensitive = options.includes("--sensitive");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Set ${name}'s ${key} on ${slug}`,
    changes: [
      `Value: ${value.length} characters from ${file === "-" ? "stdin" : file}, never shown.`,
      sensitive ? "Stored as sensitive: the engine will not serve it back." : "Stored as plain configuration, readable through the API.",
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  // A PUT of one entry, which the engine merges: the others stay set.
  const res = await call(deps, scope, {
    method: "PUT",
    path: agentPath(slug, `/skills/${encodeURIComponent(name)}/env`),
    body: { env: [{ key, value, sensitive }] },
  });
  reportWrite(deps, context, res, `Set ${key} for ${name} on ${slug}.`);
}

async function skillsEnvUnset(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "skills env unset");
  const name = requireSecond(args, "skills env unset", "skill name");
  const options = args.slice(2);
  assertKnown(options, { value: ["--key", "--confirm"] }, "agent skills env unset option");
  const key = takeValue(options, "--key");
  if (key === undefined) throw new ConfigError("polyant-cli agent skills env unset needs --key <name>.");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Remove ${name}'s ${key} from ${slug}`,
    changes: [`Delete the stored ${key}. ${name} stops working on ${slug} if it needs it.`],
    destructive: { confirm: key },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "DELETE",
    path: agentPath(slug, `/skills/${encodeURIComponent(name)}/env/${encodeURIComponent(key)}`),
  });
  reportWrite(deps, context, res, `Removed ${key} from ${name} on ${slug}.`);
}

// --- knowledge ---------------------------------------------------------------

interface DocumentRow {
  id: string;
  filename: string;
  sizeBytes: number | null;
  status: string;
  chunkCount: number | null;
  errorMessage: string | null;
  updatedAt: string | null;
}

async function knowledgeList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "knowledge list");
  assertKnown(args.slice(1), {}, "agent knowledge list option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/knowledge");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const documents = expectArray<DocumentRow>((res.body as { documents?: unknown } | null)?.documents, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "FILENAME", "STATUS", "CHUNKS", "BYTES", "UPDATED"],
      rows: documents.map((doc) => [
        text(doc.id),
        text(doc.filename),
        // An ingestion failure is the row an operator needs, and `status` alone
        // does not say why, so the message rides along in the same cell.
        doc.errorMessage === null || doc.errorMessage === undefined ? text(doc.status) : `${doc.status}: ${doc.errorMessage}`,
        text(doc.chunkCount),
        text(doc.sizeBytes),
        text(doc.updatedAt),
      ]),
      emptyMessage: `Agent ${slug} has no knowledge documents.`,
    })}\n`,
  );
}

async function knowledgeShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "knowledge show");
  const docId = requireSecond(args, "knowledge show", "document id");
  assertKnown(args.slice(2), {}, "agent knowledge show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: agentPath(slug, `/knowledge/${encodeURIComponent(docId)}`) });
  writeRawResponse(deps.io, res.raw);
}

async function knowledgeAdd(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "knowledge add");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--filename", "--confirm"] }, "agent knowledge add option");
  const file = requireFile(options, "knowledge add");
  const content = await deps.readPayload(file);
  if (content.trim().length === 0) throw new ConfigError(`${file === "-" ? "stdin" : file} contained no content.`);
  const filename = takeValue(options, "--filename") ?? (file === "-" ? undefined : file.split("/").pop());
  if (filename === undefined || filename.length === 0) {
    throw new ConfigError("polyant-cli agent knowledge add needs --filename <name> when the content comes from stdin.");
  }

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Add ${filename} to ${slug}'s knowledge`,
    changes: [
      `Upload ${content.length} characters from ${file === "-" ? "stdin" : file}.`,
      "The engine chunks and embeds it; the document is not searchable until its status reaches ready.",
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: agentPath(slug, "/knowledge"), body: { filename, content } });
  reportWrite(deps, context, res, `Added ${filename} to ${slug}.`);
}

async function knowledgeRemove(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "knowledge remove");
  const docId = requireSecond(args, "knowledge remove", "document id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent knowledge remove option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Remove document ${docId} from ${slug}`,
    changes: [`Delete the document and its embeddings. ${slug} stops retrieving from it.`],
    destructive: { confirm: docId },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: agentPath(slug, `/knowledge/${encodeURIComponent(docId)}`) });
  reportWrite(deps, context, res, `Removed document ${docId} from ${slug}.`);
}

async function knowledgeExport(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "knowledge export");
  assertKnown(args.slice(1), {}, "agent knowledge export option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: agentPath(slug, "/knowledge/export") });
  writeRawResponse(deps.io, res.raw);
}

async function knowledgeImport(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "knowledge import");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent knowledge import option");
  const file = requireFile(options, "knowledge import");
  const body = await readPayloadObject(deps, file);

  const scope = await scopeFor(deps, context);
  const documents = Array.isArray(body.documents) ? body.documents.length : 0;
  const plan = {
    title: `Import ${documents} document(s) into ${slug}`,
    changes: [`Read from ${file === "-" ? "stdin" : file}.`, "Each document is re-chunked and re-embedded on arrival."],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: agentPath(slug, "/knowledge/import"), body });
  reportWrite(deps, context, res, `Imported into ${slug}.`);
}

// --- scheduled tasks ---------------------------------------------------------

async function tasksList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "tasks list");
  const options = args.slice(1);
  assertKnown(options, { value: ["--limit", "--offset"], boolean: ["--enabled-only"] }, "agent tasks list option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/scheduled-tasks");
  const res = await call(deps, scope, {
    path,
    query: { ...paging(options), ...(options.includes("--enabled-only") ? { enabledOnly: "true" } : {}) },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const tasks = expectArray<ScheduledTask>(
    (res.body as Partial<ScheduledTasksResponse> | null)?.tasks,
    `GET ${path}`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "NAME", "SCHEDULE", "ENABLED", "NEXT RUN", "CHANNEL"],
      rows: tasks.map((task) => [
        text(task.id),
        text(task.name),
        text(task.scheduleHuman),
        task.enabled ? "yes" : "no",
        text(task.nextRunAt),
        text(task.outboundChannel),
      ]),
      emptyMessage: `Agent ${slug} has no scheduled tasks.`,
    })}\n`,
  );
}

async function tasksShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "tasks show");
  const id = requireSecond(args, "tasks show", "task id");
  assertKnown(args.slice(2), {}, "agent tasks show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: agentPath(slug, `/scheduled-tasks/${encodeURIComponent(id)}`) });
  writeRawResponse(deps.io, res.raw);
}

async function tasksRuns(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "tasks runs");
  const options = args.slice(1);
  assertKnown(options, { value: ["--task", "--status", "--limit", "--offset"] }, "agent tasks runs option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/scheduled-tasks/runs");
  const res = await call(deps, scope, {
    path,
    query: {
      ...paging(options),
      ...maybe("taskId", takeValue(options, "--task")),
      ...maybe("status", takeValue(options, "--status")),
    },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const runs = expectArray<{ id: string; taskId: string; status: string; startedAt: string | null; error?: string | null }>(
    (res.body as { runs?: unknown } | null)?.runs,
    `GET ${path}`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["RUN", "TASK", "STATUS", "STARTED", "ERROR"],
      rows: runs.map((run) => [text(run.id), text(run.taskId), text(run.status), text(run.startedAt), text(run.error)]),
      emptyMessage: `Agent ${slug} has no recorded task runs.`,
    })}\n`,
  );
}

async function tasksCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "tasks create");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent tasks create option");
  const file = requireFile(options, "tasks create");
  const body = await readPayloadObject(deps, file);
  for (const field of ["name", "prompt", "schedule"]) {
    if (body[field] === undefined) throw new ConfigError(`The task payload needs a ${field}.`);
  }

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Create scheduled task ${JSON.stringify(text(body.name))} on ${slug}`,
    changes: [`Keys: ${Object.keys(body).sort().join(", ")}.`, "The task starts running on its schedule as soon as it exists."],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: agentPath(slug, "/scheduled-tasks"), body });
  reportWrite(deps, context, res, `Created scheduled task on ${slug}.`);
}

async function tasksUpdate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "tasks update");
  const id = requireSecond(args, "tasks update", "task id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent tasks update option");
  const file = requireFile(options, "tasks update");
  const body = await readPayloadObject(deps, file);

  const scope = await scopeFor(deps, context);
  const plan = { title: `Update scheduled task ${id} on ${slug}`, changes: [`Patch keys: ${Object.keys(body).sort().join(", ")}.`] };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PATCH", path: agentPath(slug, `/scheduled-tasks/${encodeURIComponent(id)}`), body });
  reportWrite(deps, context, res, `Updated scheduled task ${id}.`);
}

async function tasksDelete(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "tasks delete");
  const id = requireSecond(args, "tasks delete", "task id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent tasks delete option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Delete scheduled task ${id} from ${slug}`,
    changes: [`Remove the task and stop its schedule.`],
    destructive: { confirm: id },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: agentPath(slug, `/scheduled-tasks/${encodeURIComponent(id)}`) });
  reportWrite(deps, context, res, `Deleted scheduled task ${id}.`);
}

async function tasksRun(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "tasks run");
  const id = requireSecond(args, "tasks run", "task id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent tasks run option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Run scheduled task ${id} on ${slug} now`,
    changes: ["The task executes for real: it calls the model and delivers to its outbound channel, exactly as a scheduled run would."],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: agentPath(slug, `/scheduled-tasks/${encodeURIComponent(id)}/run`) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);
  deps.io.stdout(`Ran scheduled task ${id}.\n`);
}

// --- event sources -----------------------------------------------------------

async function eventsShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "events show");
  assertKnown(args.slice(1), {}, "agent events show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: agentPath(slug, "/event-sources") });
  writeRawResponse(deps.io, res.raw);
}

async function eventsAdd(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "events add");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent events add option");
  const file = requireFile(options, "events add");
  const body = await readPayloadObject(deps, file);

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Add an event source to ${slug}`,
    changes: [`Keys: ${Object.keys(body).sort().join(", ")}.`, "The engine mints an ingest token; it is in the response and shown once."],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: agentPath(slug, "/event-sources"), body });
  // The token is in the body, so the body is the answer — printing a one-line
  // confirmation instead would discard the only copy of it.
  writeRawResponse(deps.io, res.raw);
}

/**
 * The ingest URL of one source. It has a route of its own because the list
 * deliberately no longer carries it: the token it embeds lets its holder inject
 * events into the agent, so listing (`room:read`) and revealing (`room:write`)
 * are different questions with different answers.
 */
async function eventsUrl(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "events url");
  const id = requireSecond(args, "events url", "event source id");
  assertKnown(args.slice(2), {}, "agent events url option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: agentPath(slug, `/event-sources/${encodeURIComponent(id)}/webhook-url`) });
  writeRawResponse(deps.io, res.raw);
}

async function eventsUpdate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "events update");
  const id = requireSecond(args, "events update", "event source id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent events update option");
  const file = requireFile(options, "events update");
  const body = await readPayloadObject(deps, file);

  const scope = await scopeFor(deps, context);
  const plan = { title: `Update event source ${id} on ${slug}`, changes: [`Replace it with the keys: ${Object.keys(body).sort().join(", ")}.`] };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PUT", path: agentPath(slug, `/event-sources/${encodeURIComponent(id)}`), body });
  reportWrite(deps, context, res, `Updated event source ${id}.`);
}

async function eventsRemove(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "events remove");
  const id = requireSecond(args, "events remove", "event source id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent events remove option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Remove event source ${id} from ${slug}`,
    changes: ["Its ingest token stops being accepted immediately; anything posting to it starts failing."],
    destructive: { confirm: id },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: agentPath(slug, `/event-sources/${encodeURIComponent(id)}`) });
  reportWrite(deps, context, res, `Removed event source ${id}.`);
}

async function eventsRotate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "events rotate");
  const id = requireSecond(args, "events rotate", "event source id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent events rotate option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Rotate event source ${id}'s token`,
    changes: ["The current token stops working the moment the new one is issued. Update every producer before rotating."],
    destructive: { confirm: id },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: agentPath(slug, `/event-sources/${encodeURIComponent(id)}/rotate-token`) });
  writeRawResponse(deps.io, res.raw);
}

async function eventsDefinitions(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "events definitions");
  const id = requireSecond(args, "events definitions", "event source id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent events definitions option");
  const file = takeValue(options, "--file");
  const base = agentPath(slug, `/event-sources/${encodeURIComponent(id)}/definitions`);

  if (file === undefined) {
    const scope = await scopeFor(deps, context, "read");
    const res = await call(deps, scope, { path: base });
    return writeRawResponse(deps.io, res.raw);
  }

  const body = await readPayloadObject(deps, file);
  const scope = await scopeFor(deps, context);
  const plan = { title: `Add an event definition to source ${id}`, changes: [`Keys: ${Object.keys(body).sort().join(", ")}.`] };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: base, body });
  reportWrite(deps, context, res, `Added an event definition to ${id}.`);
}

// --- retention ----------------------------------------------------------------

async function retentionShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "retention show");
  assertKnown(args.slice(1), {}, "agent retention show option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: agentPath(slug, "/retention") });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as { policy?: Record<string, unknown> | null };
  if (body.policy === null || body.policy === undefined) {
    // There is no deployment default any more: `RETENTION_DEFAULT_DAYS` is gone
    // and a policy must state its own window, so no policy means nothing is ever
    // purged. Saying "the default applies" here named a number that no longer
    // exists and described the opposite behaviour.
    return deps.io.stdout(`Agent ${slug} has no retention policy: nothing is purged on a schedule.\n`);
  }
  writePrettyResource(deps.io, [
    { label: "enabled", value: text(body.policy.enabled) },
    { label: "retentionDays", value: text(body.policy.retentionDays) },
    { label: "preserveGovernance", value: text(body.policy.preserveGovernance) },
    { label: "schedule", value: JSON.stringify(body.policy.schedule ?? null) },
  ]);
}

async function retentionSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "retention set");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent retention set option");
  const file = requireFile(options, "retention set");
  const body = await readPayloadObject(deps, file);
  for (const field of ["enabled", "schedule", "retentionDays", "preserveGovernance"]) {
    if (body[field] === undefined) throw new ConfigError(`The retention payload needs a ${field}.`);
  }
  // The window is the most destructive value in the product and it is now
  // declared, never defaulted: the column is NOT NULL and the route refuses a
  // policy without it. Checked here so `null` — which the CLI used to advertise
  // as allowed — fails naming the field instead of arriving as a 400 about a
  // Zod union.
  if (!Number.isInteger(body.retentionDays) || (body.retentionDays as number) <= 0) {
    throw new ConfigError(
      `The retention payload needs retentionDays as a positive integer; got ${JSON.stringify(body.retentionDays)}. ` +
        "A policy has to say how much history to keep — there is no deployment-wide default to fall back on.",
    );
  }

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Set ${slug}'s retention policy`,
    changes: [
      `Keep ${text(body.retentionDays)} days of conversations; delete what is older on the policy's schedule.`,
      body.preserveGovernance === true ? "Governance records are preserved." : "Governance records are purged along with the conversations.",
      "Deletion is permanent — the engine has no archive.",
    ],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PUT", path: agentPath(slug, "/retention"), body });
  reportWrite(deps, context, res, `Set the retention policy on ${slug}.`);
}

async function retentionUnset(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "retention unset");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "agent retention unset option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Remove ${slug}'s retention policy`,
    changes: ["Scheduled purging stops. Nothing already deleted comes back."],
    destructive: { confirm: slug },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: agentPath(slug, "/retention") });
  reportWrite(deps, context, res, `Removed the retention policy from ${slug}.`);
}

async function retentionRuns(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "retention runs");
  const options = args.slice(1);
  assertKnown(options, { value: ["--limit", "--offset"] }, "agent retention runs option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/retention/runs");
  const res = await call(deps, scope, { path, query: paging(options) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const runs = expectArray<{ id: string; status: string; trigger?: string; dryRun?: boolean; cutoff: string | null; startedAt: string | null }>(
    (res.body as { runs?: unknown } | null)?.runs,
    `GET ${path}`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["RUN", "STATUS", "TRIGGER", "DRY RUN", "CUTOFF", "STARTED"],
      rows: runs.map((run) => [
        text(run.id),
        text(run.status),
        text(run.trigger),
        run.dryRun === true ? "yes" : "no",
        text(run.cutoff),
        text(run.startedAt),
      ]),
      emptyMessage: `Agent ${slug} has no recorded retention runs.`,
    })}\n`,
  );
}

async function retentionRun(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "retention run");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"], boolean: ["--count-only"] }, "agent retention run option");
  // The engine's own dry run, not the CLI's: `--dry-run` prints a recap and
  // sends no writes, while this asks the engine to count what it WOULD delete.
  // Two different questions, so two different flags.
  const count = options.includes("--count-only");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Purge ${slug} now`,
    changes: count
      ? ["Count what the policy would delete. Nothing is removed."]
      : ["Delete every conversation past the policy's cutoff. Permanent — the engine has no archive."],
    ...(count ? {} : { destructive: { confirm: slug } }),
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: agentPath(slug, "/retention/run"), body: { dryRun: count } });
  writeRawResponse(deps.io, res.raw);
}

// --- governance assignment -----------------------------------------------------

async function agentGovernanceShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "governance show");
  assertKnown(args.slice(1), {}, "agent governance show option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/governance/policies");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  // A bare array: the engine's per-agent assignment route answers with the rows.
  const assignments = expectArray<{
    assignmentId: string;
    policyName: string;
    category: string;
    gateType: string;
    enforcement: string;
    enabled: boolean;
    immutable?: boolean;
  }>(res.body, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["ASSIGNMENT", "POLICY", "CATEGORY", "GATE", "ENFORCEMENT", "ENABLED"],
      rows: assignments.map((row) => [
        text(row.assignmentId),
        text(row.policyName),
        text(row.category),
        text(row.gateType),
        text(row.enforcement),
        row.enabled ? "yes" : "no",
      ]),
      emptyMessage: `Agent ${slug} is governed by no policies.`,
    })}\n`,
  );
}

async function agentGovernanceSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "governance set");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent governance set option");
  const file = requireFile(options, "governance set");
  const body = await readPayloadObject(deps, file);
  const assignments = Array.isArray(body.assignments) ? body.assignments : undefined;
  if (assignments === undefined) throw new ConfigError('The governance payload needs an "assignments" array.');

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Assign ${assignments.length} governance policy assignment(s) to ${slug}`,
    changes: [`Read from ${file === "-" ? "stdin" : file}.`, "Each entry names a policyId from the organisation's catalog."],
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PATCH", path: agentPath(slug, "/governance/policies"), body });
  reportWrite(deps, context, res, `Updated ${slug}'s governance assignments.`);
}

async function agentGovernanceRemove(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "governance remove");
  const assignmentId = requireSecond(args, "governance remove", "assignment id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "agent governance remove option");

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `Remove governance assignment ${assignmentId} from ${slug}`,
    changes: [`${slug} stops being governed by that policy. The policy itself stays in the catalog.`],
    destructive: { confirm: assignmentId },
  };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "DELETE",
    path: agentPath(slug, `/governance/policies/${encodeURIComponent(assignmentId)}`),
  });
  reportWrite(deps, context, res, `Removed governance assignment ${assignmentId}.`);
}

async function agentGovernanceEvents(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "governance events");
  const options = args.slice(1);
  assertKnown(options, { value: ["--limit"] }, "agent governance events option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, {
    path: agentPath(slug, "/governance/events"),
    query: maybe("limit", positiveInteger(takeValue(options, "--limit"), "--limit")),
  });
  writeRawResponse(deps.io, res.raw);
}

// --- compliance ------------------------------------------------------------------

async function complianceModelCard(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "compliance model-card");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent compliance model-card option");
  const file = takeValue(options, "--file");

  if (file === undefined) {
    const scope = await scopeFor(deps, context, "read");
    const res = await call(deps, scope, { path: agentPath(slug, "/compliance/model-card") });
    return writeRawResponse(deps.io, res.raw);
  }

  const body = await readPayloadObject(deps, file);
  if (body.sections === undefined) throw new ConfigError('The model-card payload needs a "sections" object.');
  const scope = await scopeFor(deps, context);
  const plan = { title: `Update ${slug}'s model card`, changes: [`Replace the sections read from ${file === "-" ? "stdin" : file}.`] };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, { method: "PATCH", path: agentPath(slug, "/compliance/model-card"), body });
  reportWrite(deps, context, res, `Updated ${slug}'s model card.`);
}

async function complianceSnapshots(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "compliance snapshots");
  const options = args.slice(1);
  assertKnown(options, { value: ["--version", "--label", "--confirm"], boolean: ["--take"] }, "agent compliance snapshots option");
  const version = takeValue(options, "--version");

  if (options.includes("--take")) {
    const label = takeValue(options, "--label");
    const scope = await scopeFor(deps, context);
    const plan = {
      title: `Take a compliance snapshot of ${slug}`,
      changes: ["Freeze the agent's current configuration as an immutable, numbered version."],
    };
    if (!(await preflight(deps, scope, context, options, plan))) return;
    const res = await call(deps, scope, {
      method: "POST",
      path: agentPath(slug, "/compliance/snapshots"),
      body: label === undefined ? {} : { label },
    });
    return writeRawResponse(deps.io, res.raw);
  }

  const scope = await scopeFor(deps, context, "read");
  const path = version === undefined
    ? agentPath(slug, "/compliance/snapshots")
    : agentPath(slug, `/compliance/snapshots/${encodeURIComponent(version)}`);
  const res = await call(deps, scope, { path });
  writeRawResponse(deps.io, res.raw);
}

async function complianceReports(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "compliance reports");
  const options = args.slice(1);
  assertKnown(options, { value: ["--id", "--from", "--to", "--type", "--snapshot", "--confirm"] }, "agent compliance reports option");
  const id = takeValue(options, "--id");
  const from = takeValue(options, "--from");
  const to = takeValue(options, "--to");

  if (from !== undefined || to !== undefined) {
    if (from === undefined || to === undefined) {
      throw new ConfigError("Generating a report needs both --from <iso> and --to <iso>.");
    }
    const scope = await scopeFor(deps, context);
    const plan = { title: `Generate a compliance report for ${slug}`, changes: [`Cover ${from} to ${to}.`] };
    if (!(await preflight(deps, scope, context, options, plan))) return;
    const res = await call(deps, scope, {
      method: "POST",
      path: agentPath(slug, "/compliance/reports"),
      body: {
        periodFrom: from,
        periodTo: to,
        ...(takeValue(options, "--type") === undefined ? {} : { type: takeValue(options, "--type") }),
        ...(takeValue(options, "--snapshot") === undefined ? {} : { snapshotVersion: Number(takeValue(options, "--snapshot")) }),
      },
    });
    return writeRawResponse(deps.io, res.raw);
  }

  const scope = await scopeFor(deps, context, "read");
  const path = id === undefined
    ? agentPath(slug, "/compliance/reports")
    : agentPath(slug, `/compliance/reports/${encodeURIComponent(id)}`);
  const res = await call(deps, scope, { path });
  writeRawResponse(deps.io, res.raw);
}

// --- export, import, models --------------------------------------------------------

async function exportAgent(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "export");
  assertKnown(args.slice(1), {}, "agent export option");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: agentPath(slug, "/export") });
  writeRawResponse(deps.io, res.raw);
}

async function importAgent(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  // Two routes behind one command, told apart by whether a slug is named: with
  // one the bundle OVERWRITES that agent, without one it creates a new agent in
  // the addressed workspace. Same body, opposite blast radius.
  const slug = args[0]?.startsWith("--") === false ? args[0] : undefined;
  const options = slug === undefined ? args : args.slice(1);
  assertKnown(options, { value: ["--file", "--confirm"] }, "agent import option");
  const file = requireFile(options, "import");
  const body = await readPayloadObject(deps, file);

  const scope = await scopeFor(deps, context);
  const plan =
    slug === undefined
      ? {
          title: "Import a new agent",
          changes: [`Create an agent from ${file === "-" ? "stdin" : file} in the addressed workspace.`],
        }
      : {
          title: `Overwrite ${slug} from a bundle`,
          changes: [
            `Replace ${slug}'s configuration with ${file === "-" ? "stdin" : file}.`,
            "Prompts, tools, channels and hooks are overwritten, not merged.",
          ],
          destructive: { confirm: slug },
        };
  if (!(await preflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "POST",
    path: slug === undefined ? "/api/instances/import" : agentPath(slug, "/import"),
    body,
  });
  writeRawResponse(deps.io, res.raw);
}

async function models(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--provider"] }, "agent models option");
  const provider = takeValue(args, "--provider");
  const scope = await scopeFor(deps, context, "read");
  const res = await call(deps, scope, { path: "/api/instances/models" });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const providers = (res.body as { providers?: Record<string, { models?: ModelRow[] }> } | null)?.providers ?? {};
  const rows: string[][] = [];
  for (const [name, entry] of Object.entries(providers)) {
    if (provider !== undefined && name !== provider) continue;
    for (const model of entry.models ?? []) {
      rows.push([
        name,
        text(model.id),
        text(model.tier),
        text(model.costInput),
        text(model.costOutput),
        model.supportsThinking ? "yes" : "no",
        // Read from the engine's catalog, never inferred from the model id: the
        // catalog is what the runtime consults before it accepts an image.
        model.supportsVision ? "yes" : "no",
      ]);
    }
  }
  deps.io.stdout(
    `${renderTable({
      headers: ["PROVIDER", "MODEL", "TIER", "IN /1M", "OUT /1M", "THINKING", "VISION"],
      rows,
      emptyMessage: provider === undefined ? "This deployment configures no providers." : `No provider named ${provider}.`,
    })}\n`,
  );
}

interface ModelRow {
  id: string;
  tier: string | null;
  costInput: number;
  costOutput: number;
  supportsThinking: boolean;
  /** Absent on an engine that predates the field; absent reads as no vision. */
  supportsVision?: boolean;
}

// --- the nodes merged into the `agent` family -------------------------------------

/** Added to `agent`'s tree in agent.ts, so there is one `agent` command, not two. */
export const AGENT_FAMILY_EXTRAS: Record<string, Node> = {
  skills: {
    show: {
      summary: "list the skills the catalog offers this agent, and which are on",
      usage: "Usage: polyant-cli agent skills show <slug> [--enabled-only]",
      action: skillsShow,
    },
    set: {
      summary: "replace the agent's enabled skill selection",
      usage: `Usage: polyant-cli agent skills set <slug> --enable <name,name> | --none

REPLACES the selection: a skill not listed is disabled.`,
      action: skillsSet,
      mutates: true,
    },
    autoload: {
      summary: "load a skill into every turn, or only on demand",
      usage: "Usage: polyant-cli agent skills autoload <slug> <name> --on | --off",
      action: skillsAutoLoad,
      mutates: true,
    },
    upgrade: {
      summary: "move a skill to the catalog's current version",
      usage: "Usage: polyant-cli agent skills upgrade <slug> <name>",
      action: skillsUpgrade,
      mutates: true,
    },
    rollback: {
      summary: "pin a skill back to an earlier version",
      usage: `Usage: polyant-cli agent skills rollback <slug> <name> --version-id <id>

The ids come from \`polyant-cli skill versions <name>\`.`,
      action: skillsRollback,
      mutates: true,
    },
    env: {
      show: {
        summary: "list a skill's environment on this agent",
        usage: "Usage: polyant-cli agent skills env show <slug> <name>\n\nPresence only for a sensitive entry — the engine does not serve its value back.",
        action: skillsEnvShow,
      },
      set: {
        summary: "set one environment entry for a skill",
        usage: `Usage: polyant-cli agent skills env set <slug> <name> --key <key> --file <path|-> [--sensitive]

The value comes from a file or stdin, never a flag, and is never printed.`,
        action: skillsEnvSet,
        mutates: true,
      },
      unset: {
        summary: "remove one environment entry for a skill",
        usage: "Usage: polyant-cli agent skills env unset <slug> <name> --key <key> --yes --confirm <key>",
        action: skillsEnvUnset,
        mutates: true,
      },
    },
  },
  knowledge: {
    list: {
      summary: "list an agent's knowledge documents and their ingestion status",
      usage: "Usage: polyant-cli agent knowledge list <slug>\n\nA failed ingestion shows its error next to the status.",
      action: knowledgeList,
    },
    show: {
      summary: "show one document, with its raw content",
      usage: "Usage: polyant-cli agent knowledge show <slug> <docId>",
      action: knowledgeShow,
    },
    add: {
      summary: "upload a document from a file or stdin",
      usage: `Usage: polyant-cli agent knowledge add <slug> --file <path|-> [--filename <name>]

The filename defaults to the file's own; from stdin it must be given. The
document is not retrievable until the engine finishes chunking and embedding it.`,
      action: knowledgeAdd,
      mutates: true,
    },
    remove: {
      summary: "delete one document and its embeddings",
      usage: "Usage: polyant-cli agent knowledge remove <slug> <docId> --yes --confirm <docId>",
      action: knowledgeRemove,
      mutates: true,
    },
    export: {
      summary: "print every document as a JSON bundle",
      usage: "Usage: polyant-cli agent knowledge export <slug>\n\nRound-trips into `agent knowledge import`.",
      action: knowledgeExport,
    },
    import: {
      summary: "import a knowledge bundle from a file or stdin",
      usage: "Usage: polyant-cli agent knowledge import <slug> --file <path|->",
      action: knowledgeImport,
      mutates: true,
    },
  },
  tasks: {
    list: {
      summary: "list an agent's scheduled tasks",
      usage: "Usage: polyant-cli agent tasks list <slug> [--enabled-only] [--limit <n>] [--offset <n>]",
      action: tasksList,
    },
    show: { summary: "show one scheduled task", usage: "Usage: polyant-cli agent tasks show <slug> <taskId>", action: tasksShow },
    runs: {
      summary: "list recorded task runs",
      usage: "Usage: polyant-cli agent tasks runs <slug> [--task <id>] [--status <status>] [--limit <n>] [--offset <n>]",
      action: tasksRuns,
    },
    create: {
      summary: "create a scheduled task from a JSON file or stdin",
      usage: `Usage: polyant-cli agent tasks create <slug> --file <path|->

Needs name, prompt and schedule. The schedule is one of the engine's three
types — cron, interval or one-shot — so it arrives as JSON rather than as flags.`,
      action: tasksCreate,
      mutates: true,
    },
    update: {
      summary: "patch a scheduled task from a JSON file or stdin",
      usage: "Usage: polyant-cli agent tasks update <slug> <taskId> --file <path|->",
      action: tasksUpdate,
      mutates: true,
    },
    delete: {
      summary: "delete a scheduled task",
      usage: "Usage: polyant-cli agent tasks delete <slug> <taskId> --yes --confirm <taskId>",
      action: tasksDelete,
      mutates: true,
    },
    run: {
      summary: "run a scheduled task now",
      usage: `Usage: polyant-cli agent tasks run <slug> <taskId>

A real run: it calls the model and delivers to the task's outbound channel.`,
      action: tasksRun,
      mutates: true,
    },
  },
  events: {
    show: {
      summary: "list an agent's event sources",
      usage: `Usage: polyant-cli agent events show <slug>

The ingest URL is NOT listed: the token it embeds lets its holder drive the
agent, so the engine withholds it from a read-only caller. Reveal one with
\`agent events url <slug> <id>\`.`,
      action: eventsShow,
    },
    add: {
      summary: "add an event source from a JSON file or stdin",
      usage: `Usage: polyant-cli agent events add <slug> --file <path|->

The response carries the ingest token and is printed whole. It is not the only
copy — \`agent events url\` reveals it again — but every later look needs
room:write, so keep this one.`,
      action: eventsAdd,
      mutates: true,
    },
    url: {
      summary: "reveal one event source's ingest URL",
      usage: `Usage: polyant-cli agent events url <slug> <id>

Needs room:write, not room:read: the URL embeds a bearer-equivalent token.`,
      action: eventsUrl,
    },
    update: {
      summary: "replace an event source from a JSON file or stdin",
      usage: "Usage: polyant-cli agent events update <slug> <id> --file <path|->",
      action: eventsUpdate,
      mutates: true,
    },
    remove: {
      summary: "delete an event source",
      usage: "Usage: polyant-cli agent events remove <slug> <id> --yes --confirm <id>",
      action: eventsRemove,
      mutates: true,
    },
    rotate: {
      summary: "issue a new ingest token, invalidating the current one",
      usage: `Usage: polyant-cli agent events rotate <slug> <id> --yes --confirm <id>

The old token stops working immediately — update every producer first.`,
      action: eventsRotate,
      mutates: true,
    },
    definitions: {
      summary: "list an event source's definitions, or add one",
      usage: "Usage: polyant-cli agent events definitions <slug> <id> [--file <path|->]\n\nWithout --file this reads; with it, it adds.",
      action: eventsDefinitions,
      mutates: true,
    },
  },
  retention: {
    show: {
      summary: "show an agent's retention policy",
      usage: "Usage: polyant-cli agent retention show <slug>\n\nNo policy means nothing is purged on a schedule: there is no deployment-wide\nwindow to fall back on.",
      action: retentionShow,
    },
    set: {
      summary: "set the retention policy from a JSON file or stdin",
      usage: `Usage: polyant-cli agent retention set <slug> --file <path|->

Needs enabled, schedule, retentionDays and preserveGovernance. retentionDays is
a positive integer and is refused absent or null: a policy has to state how much
history it keeps. Purging is permanent — the engine has no archive.`,
      action: retentionSet,
      mutates: true,
    },
    unset: {
      summary: "remove the retention policy and stop scheduled purging",
      usage: "Usage: polyant-cli agent retention unset <slug> --yes --confirm <slug>",
      action: retentionUnset,
      mutates: true,
    },
    runs: {
      summary: "list recorded purge runs",
      usage: "Usage: polyant-cli agent retention runs <slug> [--limit <n>] [--offset <n>]",
      action: retentionRuns,
    },
    run: {
      summary: "purge now, or count what a purge would delete",
      usage: `Usage: polyant-cli agent retention run <slug> --yes --confirm <slug>
       polyant-cli agent retention run <slug> --count-only

--count-only is the ENGINE's dry run: it reports what would go. \`--dry-run\` is
the CLI's, and sends no writes.`,
      action: retentionRun,
      mutates: true,
    },
  },
  governance: {
    show: {
      summary: "list the governance policies assigned to an agent",
      usage: "Usage: polyant-cli agent governance show <slug>",
      action: agentGovernanceShow,
    },
    set: {
      summary: "assign governance policies from a JSON file or stdin",
      usage: `Usage: polyant-cli agent governance set <slug> --file <path|->

Needs an "assignments" array, each naming a policyId from the organisation's
catalog. Run \`polyant-cli governance policy list\` for the ids.`,
      action: agentGovernanceSet,
      mutates: true,
    },
    remove: {
      summary: "remove one governance assignment",
      usage: "Usage: polyant-cli agent governance remove <slug> <assignmentId> --yes --confirm <assignmentId>",
      action: agentGovernanceRemove,
      mutates: true,
    },
    events: {
      summary: "the governance decisions recorded for this agent",
      usage: "Usage: polyant-cli agent governance events <slug> [--limit <n>]",
      action: agentGovernanceEvents,
    },
  },
  compliance: {
    "model-card": {
      summary: "show an agent's model card, or replace its sections",
      usage: "Usage: polyant-cli agent compliance model-card <slug> [--file <path|->]\n\nWithout --file this reads; with it, it writes.",
      action: complianceModelCard,
      mutates: true,
    },
    snapshots: {
      summary: "list configuration snapshots, show one, or take one",
      usage: `Usage: polyant-cli agent compliance snapshots <slug> [--version <n>]
       polyant-cli agent compliance snapshots <slug> --take [--label <text>]

A snapshot freezes the agent's configuration as an immutable numbered version.`,
      action: complianceSnapshots,
      mutates: true,
    },
    reports: {
      summary: "list compliance reports, show one, or generate one",
      usage: `Usage: polyant-cli agent compliance reports <slug> [--id <id>]
       polyant-cli agent compliance reports <slug> --from <iso> --to <iso> [--type <t>] [--snapshot <n>]`,
      action: complianceReports,
      mutates: true,
    },
  },
  export: {
    summary: "print an agent's full configuration as a bundle",
    usage: "Usage: polyant-cli agent export <slug>\n\nRound-trips into `agent import`.",
    action: exportAgent,
  },
  import: {
    summary: "create an agent from a bundle, or overwrite one",
    usage: `Usage: polyant-cli agent import --file <path|->                        (create)
       polyant-cli agent import <slug> --file <path|-> --yes --confirm <slug>  (overwrite)

Naming a slug OVERWRITES that agent: prompts, tools, channels and hooks are
replaced, not merged. Without one, a new agent lands in the addressed workspace.`,
    action: importAgent,
    mutates: true,
  },
  models: {
    summary: "list the providers and models this deployment offers",
    usage: `Usage: polyant-cli agent models [--provider <name>]

Costs are per million tokens, straight from the engine's catalog. VISION is what
decides whether a channel may hand this model an image; a model without it drops
attachments rather than failing the turn.`,
    action: models,
  },
};
