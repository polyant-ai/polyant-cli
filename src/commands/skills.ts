// SPDX-License-Identifier: Apache-2.0
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { ORG_NOTE, orgPath, preflight, readScope, report, requirePositional } from "../runtime/org.js";
import { call, expectArray, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";

/**
 * The skill catalog an organisation owns. It moved off `/api/skills` onto
 * `/api/organizations/:orgSlug/skills` when skill-slug uniqueness moved from
 * global to per-organisation, so a catalog read is org-scoped like the rest of
 * administration — not deployment-wide.
 *
 * A row's `owner` is load-bearing and cannot be inferred: the catalog is the
 * union of the organisation's OWN skills and the platform-owned ones granted to
 * it, and the two can share a name when an organisation deliberately overrides a
 * platform skill. Every listing prints it.
 */
function skillsPath(org: string, rest = ""): string {
  return orgPath(org, `/skills${rest}`);
}

interface SkillRow {
  name: string;
  description: string;
  category?: string;
  owner: "organization" | "platform";
  requiredEnv?: { name: string; description?: string }[];
  requiredTools?: string[];
}

async function skillList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--owner"] }, "skill list option");
  const owner = takeValue(args, "--owner");
  if (owner !== undefined && owner !== "organization" && owner !== "platform") {
    throw new ConfigError('--owner takes "organization" or "platform".');
  }
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: skillsPath(org) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const all = expectArray<SkillRow>((res.body as { skills?: unknown } | null)?.skills, `GET ${skillsPath(org)}`);
  const skills = owner === undefined ? all : all.filter((skill) => skill.owner === owner);
  deps.io.stdout(
    `${renderTable({
      headers: ["NAME", "OWNER", "CATEGORY", "ENV", "DESCRIPTION"],
      rows: skills.map((skill) => [
        text(skill.name),
        text(skill.owner),
        text(skill.category),
        String((skill.requiredEnv ?? []).length),
        text(skill.description),
      ]),
      emptyMessage: `Organisation ${org}'s catalog has no skills.`,
    })}\n`,
  );
}

async function skillShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const name = requirePositional(args, "skill show", "skill name");
  assertKnown(args.slice(1), { boolean: ["--content"] }, "skill show option");
  const { scope, org } = await readScope(deps, context);
  const res = await call(deps, scope, { path: skillsPath(org, `/${encodeURIComponent(name)}`) });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const skill = res.body as (SkillRow & { content?: string }) | null;
  if (skill === null) throw new ConfigError(`GET ${skillsPath(org, `/${name}`)} returned no skill.`);
  // The content is the skill. Printed alone under --content so it pipes into a
  // file or a diff without the surrounding metadata.
  if (args.includes("--content")) return deps.io.stdout(`${skill.content ?? ""}\n`);

  writePrettyResource(deps.io, [
    { label: "name", value: text(skill.name) },
    { label: "owner", value: text(skill.owner) },
    { label: "category", value: text(skill.category) },
    { label: "description", value: text(skill.description) },
    { label: "requiredEnv", value: (skill.requiredEnv ?? []).map((entry) => entry.name).join(", ") || "(none)" },
    { label: "requiredTools", value: (skill.requiredTools ?? []).join(", ") || "(none)" },
  ]);
}

async function skillVersions(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const name = requirePositional(args, "skill versions", "skill name");
  assertKnown(args.slice(1), { value: ["--version"] }, "skill versions option");
  const version = takeValue(args.slice(1), "--version");
  const { scope, org } = await readScope(deps, context);

  // One version is a different route, not a filter over the list: only it
  // carries the version's content.
  if (version !== undefined) {
    const res = await call(deps, scope, {
      path: skillsPath(org, `/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`),
    });
    return writeRawResponse(deps.io, res.raw);
  }

  const path = skillsPath(org, `/${encodeURIComponent(name)}/versions`);
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const versions = expectArray<{ version: string; changelog: string | null; createdAt: string | null }>(
    (res.body as { versions?: unknown } | null)?.versions,
    `GET ${path}`,
  );
  deps.io.stdout(
    `${renderTable({
      headers: ["VERSION", "CREATED", "CHANGELOG"],
      rows: versions.map((row) => [text(row.version), text(row.createdAt), text(row.changelog)]),
      emptyMessage: `Skill ${name} has no recorded versions.`,
    })}\n`,
  );
}

async function skillExport(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const name = args[0]?.startsWith("--") === false ? args[0] : undefined;
  assertKnown(name === undefined ? args : args.slice(1), {}, "skill export option");
  const { scope, org } = await readScope(deps, context);

  // The bundle is the payload, whole and unmodified: it round-trips through
  // `skill import`, so re-rendering it as a table would only make it unusable.
  const path = name === undefined ? skillsPath(org, "/catalog/export") : skillsPath(org, `/${encodeURIComponent(name)}/export`);
  const res = await call(deps, scope, { path });
  writeRawResponse(deps.io, res.raw);
}

async function skillImport(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--file", "--confirm"] }, "skill import option");
  const file = takeValue(args, "--file");
  if (file === undefined) throw new ConfigError('polyant-cli skill import needs --file <path> (or --file - for stdin).');
  const body = parseBundle(await deps.readPayload(file), file === "-" ? "The stdin payload" : file);

  const { scope, org } = await readScope(deps, context);
  const entries = Array.isArray((body as { skills?: unknown }).skills) ? (body as { skills: unknown[] }).skills : [];
  const plan = {
    title: `Import ${entries.length} skill(s) into ${org}`,
    changes: [
      `Read from ${file === "-" ? "stdin" : file}.`,
      "A skill already in the catalog gains a version; one that is not is created.",
    ],
  };
  if (!(await preflight(deps, scope, org, context, args, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: skillsPath(org, "/catalog/import"), body });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const result = (res.body ?? {}) as { created?: string[]; updated?: string[]; skipped?: string[] };
  deps.io.stdout(
    `created ${(result.created ?? []).length}, updated ${(result.updated ?? []).length}, skipped ${(result.skipped ?? []).length}\n`,
  );
  const skipped = result.skipped ?? [];
  // A skipped entry is silent in the counts alone, and it is the one an operator
  // has to act on: the bundle carried it but the catalog did not take it.
  if (skipped.length > 0) deps.io.stderr(`skipped: ${skipped.join(", ")}\n`);
}

function parseBundle(raw: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${source} must be a JSON object, the bundle "skill export" produces.`);
  }
  return parsed as Record<string, unknown>;
}

async function skillSet(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const name = requirePositional(args, "skill set", "skill name");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--description", "--changelog", "--confirm"] }, "skill set option");
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError('polyant-cli skill set needs --file <path> (or --file - for stdin).');
  const content = await deps.readPayload(file);
  if (content.trim().length === 0) throw new ConfigError(`${file === "-" ? "stdin" : file} contained no content.`);
  const description = takeValue(options, "--description");
  const changelog = takeValue(options, "--changelog");

  const { scope, org } = await readScope(deps, context);

  // Create and update are different verbs on different routes, and the engine
  // rejects a create for a name it already holds. Which one applies is a fact
  // about the catalog, so it is read rather than asked for.
  const listed = await call(deps, scope, { path: skillsPath(org) });
  const existing = expectArray<SkillRow>((listed.body as { skills?: unknown } | null)?.skills, `GET ${skillsPath(org)}`).find(
    (skill) => skill.name === name && skill.owner === "organization",
  );
  if (existing === undefined && description === undefined) {
    throw new ConfigError(`polyant-cli skill set needs --description <text> to create ${JSON.stringify(name)}.`);
  }

  const plan = {
    title: existing === undefined ? `Create skill ${name} in ${org}` : `Publish a new version of ${name}`,
    changes: [
      `Content: ${content.length} characters from ${file === "-" ? "stdin" : file}.`,
      ...(description === undefined ? [] : [`Description: ${JSON.stringify(description)}.`]),
      ...(existing === undefined ? [] : ["The previous version stays in the version history and can be rolled back to."]),
    ],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res =
    existing === undefined
      ? await call(deps, scope, {
          method: "POST",
          path: skillsPath(org),
          body: { name, description, content },
        })
      : await call(deps, scope, {
          method: "PUT",
          path: skillsPath(org, `/${encodeURIComponent(name)}`),
          body: {
            description: description ?? existing.description,
            content,
            ...(changelog === undefined ? {} : { changelog }),
          },
        });
  report(deps, context, res.raw, existing === undefined ? `Created skill ${name}.` : `Published a new version of ${name}.`);
}

async function skillDelete(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const name = requirePositional(args, "skill delete", "skill name");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "skill delete option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Delete skill ${name} from ${org}'s catalog`,
    changes: [
      `Remove ${name} and its version history.`,
      "Agents with it enabled lose it. A platform-owned skill of the same name is not affected — only this organisation's own row is deleted.",
    ],
    destructive: { confirm: name },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: skillsPath(org, `/${encodeURIComponent(name)}`) });
  report(deps, context, res.raw, `Deleted skill ${name}.`);
}

export const skillFamily: Record<string, Node> = {
  list: {
    summary: "list the organisation's skill catalog",
    usage: `Usage: polyant-cli skill list [--owner organization|platform]

The catalog is the union of the organisation's own skills and the platform-owned
ones granted to it; two rows can share a name when an organisation overrides a
platform skill, so OWNER is always printed. ${ORG_NOTE}`,
    action: skillList,
  },
  show: {
    summary: "show one skill, or print its content alone",
    usage: `Usage: polyant-cli skill show <name> [--content]\n\n--content prints the skill body and nothing else, so it pipes into a file or a diff. ${ORG_NOTE}`,
    action: skillShow,
  },
  versions: {
    summary: "list a skill's versions, or show one",
    usage: `Usage: polyant-cli skill versions <name> [--version <version>]\n\n${ORG_NOTE}`,
    action: skillVersions,
  },
  export: {
    summary: "print the catalog bundle, or one skill's bundle",
    usage: `Usage: polyant-cli skill export [name]

The bundle passes through unmodified and round-trips into \`skill import\`. ${ORG_NOTE}`,
    action: skillExport,
  },
  import: {
    summary: "import a catalog bundle from a file or stdin",
    usage: `Usage: polyant-cli skill import --file <path|->

A skill already in the catalog gains a version rather than being replaced.
Anything the engine skips is named on stderr. ${ORG_NOTE}`,
    action: skillImport,
    mutates: true,
  },
  set: {
    summary: "create a skill, or publish a new version of one",
    usage: `Usage: polyant-cli skill set <name> --file <path|-> [--description <text>] [--changelog <text>]

Which of the two applies is read from the catalog, not asked for: the engine
refuses a create for a name it already holds. --description is required only
when the skill does not exist yet. ${ORG_NOTE}`,
    action: skillSet,
    mutates: true,
  },
  delete: {
    summary: "delete a skill and its version history",
    usage: `Usage: polyant-cli skill delete <name> --yes --confirm <name>\n\n${ORG_NOTE}`,
    action: skillDelete,
    mutates: true,
  },
};
