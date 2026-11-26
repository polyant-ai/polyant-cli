// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BuildFailure, Message } from "esbuild";
import { ConfigError } from "../exit.js";
import type { LocalizedText, PluginProject } from "./project.js";
import { createTarGz } from "./tar.js";

/**
 * Builds one plugin project into a runtime bundle: a `.tar.gz` holding
 *
 *  - `worker.mjs`, one ESM file with every npm dependency inlined (only Node
 *    built-ins stay external), which the engine runs in a worker;
 *  - `definitions.json`, the tools and hooks as data, which the engine registers
 *    without importing plugin code;
 *  - `plugin.json`, the bundle's identity, which must match the catalogue entry.
 *
 * WHY esbuild IS A DEPENDENCY OF THIS CLI, NOT OF THE PROJECT
 *
 * `dev connect` runs the project's own `tsx` because a bare import in a tool
 * file must resolve from the project, and a loader in the CLI's `dist/` would
 * resolve it from the CLI. esbuild has no such trap: it resolves every import
 * from `resolveDir` and `absWorkingDir`, both set to the project, wherever
 * esbuild itself is installed. And a plugin project made from the dev kit does
 * not carry esbuild, so requiring it there would add a step for nothing.
 *
 * The definitions are read by importing the built worker in a CHILD process:
 * plugin modules run code at load, and a stray timer or a crash in one must not
 * hold or take down the server.
 */

export const BUNDLE_FILES = ["plugin.json", "definitions.json", "worker.mjs"] as const;

/** The keys of a tool and of a hook that travel as data; anything else stays in the worker. */
const TOOL_KEYS = ["name", "description", "summary", "category", "requiredSecrets", "requiredKnowledge", "harness", "metaTool", "inputExamples", "inputSchema"];
const HOOK_KEYS = ["name", "description", "summary", "requiredSecrets", "mutatesResponse"];

interface RequiredSecret {
  readonly key: string;
  readonly label?: LocalizedText;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly summary?: LocalizedText;
  readonly requiredSecrets: readonly RequiredSecret[];
  readonly requiredKnowledge?: string;
  readonly harness?: unknown;
  readonly metaTool?: unknown;
  readonly mutatesResponse?: boolean;
}

export interface Definitions {
  readonly tools: readonly ToolDefinition[];
  readonly hooks: readonly ToolDefinition[];
}

export interface Permissions {
  readonly tools: string[];
  readonly hooks: string[];
  readonly requiredSecrets: string[];
  readonly oauthProviders: string[];
  readonly requiredKnowledge: string[];
  readonly mayHalt: boolean;
  readonly mayMutateResponse: boolean;
}

/** One catalogue release, as the marketplace format spells it. */
export interface Release {
  readonly version: string;
  readonly namespace: string;
  readonly engineRange: string;
  readonly artifactPath: string;
  readonly sha256: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly fileCount: number;
  readonly status: "published" | "deprecated" | "revoked";
  readonly changelogSummary: LocalizedText;
  readonly publishedAt?: string;
  readonly capabilityDescriptions?: Record<string, LocalizedText>;
  readonly hookDescriptions?: Record<string, LocalizedText>;
  readonly secretLabels?: Record<string, LocalizedText>;
  readonly permissions: Permissions;
}

export interface BuiltBundle {
  readonly pluginId: string;
  readonly bytes: Buffer;
  readonly release: Release;
}

export function artifactPath(pluginId: string, version: string, sha256: string): string {
  return `/v1/artifacts/${pluginId}/${version}/${sha256}.tar.gz`;
}

function workerEntry(project: PluginProject): string {
  const imports = [
    ...project.toolFiles.map((file, index) => `import tool${index} from ${JSON.stringify(file)};`),
    ...project.hookFiles.map((file, index) => `import hook${index} from ${JSON.stringify(file)};`),
  ].join("\n");
  const prefix = JSON.stringify(`${project.namespace}:`);
  return `${imports}
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
const toolModules = [${project.toolFiles.map((_, index) => `tool${index}`).join(", ")}];
const hookModules = [${project.hookFiles.map((_, index) => `hook${index}`).join(", ")}];
const tools = new Map(toolModules.map((tool) => [${prefix} + tool.name, tool]));
const hooks = new Map(hookModules.map((hook) => [${prefix} + hook.name, hook]));
export const definitions = {
  tools: toolModules.map((tool) => ({ ...pick(tool, ${JSON.stringify(TOOL_KEYS)}), name: ${prefix} + tool.name })),
  hooks: hookModules.map((hook) => ({ ...pick(hook, ${JSON.stringify(HOOK_KEYS)}), name: ${prefix} + hook.name })),
};
export async function invokeTool(name, input, context) {
  const tool = tools.get(name);
  if (!tool) throw new Error("Unknown tool: " + name);
  return tool.execute(input, context);
}
export async function invokeHook(name, context) {
  const hook = hooks.get(name);
  if (!hook) throw new Error("Unknown hook: " + name);
  return hook.handler(context);
}
`;
}

function describeMessages(messages: readonly Message[]): string {
  return messages
    .map((message) => (message.location ? `${message.location.file}:${message.location.line}: ${message.text}` : message.text))
    .join("\n  ");
}

async function compile(project: PluginProject, outfile: string): Promise<Uint8Array> {
  const { build } = await import("esbuild");
  let result;
  try {
    result = await build({
      stdin: { contents: workerEntry(project), resolveDir: project.root, sourcefile: "worker-entry.mjs" },
      // Paths esbuild writes into the output are relative to this, so the same
      // sources give the same bytes whatever directory the CLI runs from.
      absWorkingDir: project.root,
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      metafile: true,
      write: false,
      logLevel: "silent",
      // Plugins written in CommonJS style still call require() for built-ins.
      banner: { js: "import { createRequire as __polyantCreateRequire } from 'node:module'; const require = __polyantCreateRequire(import.meta.url);" },
    });
  } catch (error) {
    const failure = error as Partial<BuildFailure>;
    const errors = failure.errors ?? [];
    const unresolved = errors.some((message) => message.text.startsWith("Could not resolve"));
    throw new ConfigError(
      `${project.root}: the plugin does not build:\n  ${errors.length > 0 ? describeMessages(errors) : String(error)}` +
        (unresolved ? `\nRun \`npm install\` in ${project.root}: its imports resolve from its own node_modules.` : ""),
    );
  }

  const outputs = Object.values(result.metafile.outputs);
  const external = outputs
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external && !entry.path.startsWith("node:") && !isBuiltin(entry.path));
  if (external.length > 0) {
    throw new ConfigError(`${project.root}: these imports could not be bundled: ${[...new Set(external.map((entry) => entry.path))].join(", ")}.`);
  }
  const native = Object.keys(result.metafile.inputs).filter((input) => input.endsWith(".node"));
  if (native.length > 0) throw new ConfigError(`${project.root}: native addons cannot run in a runtime plugin: ${native.join(", ")}.`);
  const file = result.outputFiles?.[0];
  if (file === undefined) throw new Error("esbuild produced no output");
  return file.contents;
}

/** Imported by a child `node`, so plugin code never runs in the server's process. */
const READ_DEFINITIONS = `
const url = process.env.POLYANT_BUNDLE_WORKER_URL;
import(url).then(
  (worker) => { process.stdout.write(JSON.stringify(worker.definitions)); process.exit(0); },
  (error) => { process.stderr.write(error && error.stack ? error.stack : String(error)); process.exit(1); },
);
`;

function readDefinitions(workerFile: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", READ_DEFINITIONS],
      {
        env: { ...process.env, POLYANT_BUNDLE_WORKER_URL: pathToFileURL(workerFile).href },
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

function checkDefinitions(value: unknown, project: PluginProject): Definitions {
  const where = project.root;
  const invalid = (detail: string) =>
    new ConfigError(`${where}: ${detail}. Every *.tool.ts and *.hook.ts file must default-export defineTool(...) or defineHook(...) from @polyant-ai/plugin-sdk.`);
  const definitions = value as Definitions;
  if (!Array.isArray(definitions?.tools) || !Array.isArray(definitions?.hooks)) throw invalid("the bundle exports no definitions");
  if (definitions.tools.length !== project.toolFiles.length || definitions.hooks.length !== project.hookFiles.length) {
    throw invalid("a tool or hook file exports nothing");
  }
  for (const [kind, entries] of [["tool", definitions.tools], ["hook", definitions.hooks]] as const) {
    for (const entry of entries) {
      const name = typeof entry?.name === "string" ? entry.name : "";
      if (name === `${project.namespace}:` || name === `${project.namespace}:undefined`) throw invalid(`a ${kind} has no name`);
      if (typeof entry.description !== "string" || entry.description.length === 0) throw invalid(`${kind} ${name} has no description`);
      if (!Array.isArray(entry.requiredSecrets)) throw invalid(`${kind} ${name} has no requiredSecrets list`);
      if (kind === "tool" && typeof (entry as { inputSchema?: unknown }).inputSchema !== "object") throw invalid(`tool ${name} has no input schema`);
    }
    const names = entries.map((entry) => entry.name);
    // A tool and a hook may share a name; two tools, or two hooks, may not.
    if (new Set(names).size !== names.length) throw new ConfigError(`${where}: two ${kind}s share a name.`);
  }
  if (definitions.tools.some((tool) => tool.harness || tool.metaTool)) {
    throw new ConfigError(`${where}: harness and meta tools cannot ship as runtime plugins.`);
  }
  return definitions;
}

/** The sentence a catalogue shows per tool or hook: its `summary`, else the description's first line. */
function capabilityDescriptions(entries: readonly ToolDefinition[]): Record<string, LocalizedText> {
  return Object.fromEntries(
    entries.flatMap((entry): [string, LocalizedText][] => {
      if (entry.summary !== undefined) return [[entry.name, entry.summary]];
      const firstLine = entry.description.split("\n").find((line) => line.trim() !== "")?.trim();
      return firstLine ? [[entry.name, firstLine.slice(0, 1000)]] : [];
    }),
  );
}

function secretLabels(secrets: readonly RequiredSecret[]): Record<string, LocalizedText> {
  const labels: Record<string, LocalizedText> = {};
  for (const secret of secrets) {
    if (secret.label !== undefined && !(secret.key in labels)) labels[secret.key] = secret.label;
  }
  return labels;
}

export function permissionsFor(definitions: Definitions, project: Pick<PluginProject, "oauthProviders">): Permissions {
  const secrets = [...definitions.tools, ...definitions.hooks].flatMap((entry) => entry.requiredSecrets);
  return {
    tools: definitions.tools.map((tool) => tool.name),
    hooks: definitions.hooks.map((hook) => hook.name),
    requiredSecrets: [...new Set(secrets.map((secret) => secret.key))],
    oauthProviders: project.oauthProviders.map((provider) => provider.name),
    requiredKnowledge: [...new Set(definitions.tools.flatMap((tool) => (tool.requiredKnowledge ? [tool.requiredKnowledge] : [])))],
    // Any hook may halt a turn or replace the reply, whatever it declares; the
    // engine refuses a release whose bundle does more than this summary says.
    mayHalt: definitions.hooks.length > 0,
    mayMutateResponse: definitions.hooks.length > 0,
  };
}

export async function buildBundle(project: PluginProject, pluginId: string, publishedAt: Date): Promise<BuiltBundle> {
  const scratch = await mkdtemp(join(tmpdir(), "polyant-bundle-"));
  try {
    const workerFile = join(scratch, "worker.mjs");
    const worker = await compile(project, workerFile);
    await writeFile(workerFile, worker);
    let raw: unknown;
    try {
      raw = await readDefinitions(workerFile);
    } catch (error) {
      throw new ConfigError(`${project.root}: loading the built plugin failed:\n${(error as Error).message}`);
    }
    const definitions = checkDefinitions(raw, project);

    const files = {
      "plugin.json": Buffer.from(
        `${JSON.stringify({
          pluginId,
          version: project.version,
          namespace: project.namespace,
          engineRange: project.engineRange,
          oauthProviders: project.oauthProviders,
        })}\n`,
      ),
      "definitions.json": Buffer.from(`${JSON.stringify(definitions)}\n`),
      "worker.mjs": Buffer.from(worker),
    };
    const bytes = createTarGz(BUNDLE_FILES.map((name) => ({ name, bytes: files[name] })));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const secrets = [...definitions.tools, ...definitions.hooks].flatMap((entry) => entry.requiredSecrets);
    const labels = secretLabels(secrets);
    return {
      pluginId,
      bytes,
      release: {
        version: project.version,
        namespace: project.namespace,
        engineRange: project.engineRange,
        artifactPath: artifactPath(pluginId, project.version, sha256),
        sha256,
        compressedBytes: bytes.length,
        expandedBytes: Object.values(files).reduce((total, file) => total + file.length, 0),
        fileCount: BUNDLE_FILES.length,
        status: "published",
        changelogSummary: "",
        publishedAt: publishedAt.toISOString(),
        capabilityDescriptions: capabilityDescriptions(definitions.tools),
        ...(definitions.hooks.length > 0 ? { hookDescriptions: capabilityDescriptions(definitions.hooks) } : {}),
        ...(Object.keys(labels).length > 0 ? { secretLabels: labels } : {}),
        permissions: permissionsFor(definitions, project),
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
