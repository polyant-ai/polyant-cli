// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { valid, validRange } from "semver";
import { ConfigError } from "../exit.js";

/**
 * Reads and checks a plugin project before anything is built, so a mistake is
 * reported against `plugin.json` with what to change, instead of surfacing as a
 * catalogue the engine refuses as a whole.
 *
 * The rules are the marketplace format's: a stable namespace (the prefix of
 * every tool and hook name), a SemVer version, a SemVer engine range, no
 * `system` block (a runtime bundle cannot ask the image for packages), and at
 * least one `*.tool.ts` or `*.hook.ts` file.
 */

export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Namespaces the engine keeps for agent delegation and remote MCP tools. */
const RESERVED_NAMESPACES = new Set(["agent", "mcp"]);
const ICON_TYPES: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
const MAX_ICON_BYTES = 32 * 1024;
const MAX_LONG_DESCRIPTION = 4000;

/** Text a person reads: one string, or one string per BCP 47 tag. */
export type LocalizedText = string | Record<string, string>;

export interface PluginProject {
  readonly root: string;
  readonly namespace: string;
  readonly version: string;
  readonly engineRange: string;
  readonly oauthProviders: readonly { readonly name: string; readonly [key: string]: unknown }[];
  readonly toolFiles: readonly string[];
  readonly hookFiles: readonly string[];
  readonly presentation: {
    readonly name: LocalizedText;
    readonly summary: LocalizedText;
    readonly longDescription?: LocalizedText;
    readonly icon?: string;
    readonly category?: LocalizedText;
    readonly publisher?: string;
    readonly documentationUrl?: string;
  };
}

const LOCALE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

function isText(value: unknown, max = Infinity): value is LocalizedText {
  const fits = (text: unknown) => typeof text === "string" && text.trim().length > 0 && text.length <= max;
  if (typeof value === "string") return fits(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([tag, text]) => LOCALE_TAG.test(tag) && fits(text));
}

function within(root: string, path: string, what: string, manifestPath: string, allowRoot = false): string {
  const file = resolve(root, path);
  const fromRoot = relative(root, file);
  if ((fromRoot === "" && !allowRoot) || fromRoot.startsWith("..") || fromRoot.startsWith(sep)) {
    throw new ConfigError(`${manifestPath}: ${what} "${path}" must point inside the plugin directory.`);
  }
  return file;
}

async function sourceFiles(root: string, dir: string, suffix: "tool" | "hook"): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(join(root, dir));
  } catch {
    return [];
  }
  const pattern = new RegExp(`\\.${suffix}\\.(ts|js|mjs)$`);
  return names
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => `./${dir}/${name}`);
}

function humanize(namespace: string): string {
  return namespace.replace(/[-_.]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function readIcon(root: string, path: unknown, manifestPath: string): Promise<string | undefined> {
  if (path === undefined) return undefined;
  if (typeof path !== "string") throw new ConfigError(`${manifestPath}: "icon" must be the path of a .png, .webp or .svg file.`);
  const file = within(root, path, "icon", manifestPath);
  const type = ICON_TYPES[extname(file).toLowerCase()];
  if (type === undefined) throw new ConfigError(`${manifestPath}: icon "${path}" must be a .png, .webp or .svg file.`);
  const bytes = await readFile(file).catch(() => {
    throw new ConfigError(`${manifestPath}: icon "${path}" cannot be read.`);
  });
  if (bytes.length > MAX_ICON_BYTES) {
    throw new ConfigError(`${manifestPath}: icon "${path}" is ${bytes.length} bytes; the limit is ${MAX_ICON_BYTES}.`);
  }
  return `data:${type};base64,${bytes.toString("base64")}`;
}

/** Inline text, or the path of a .md/.txt file in the plugin, once or per locale. */
async function readLongDescription(root: string, value: unknown, manifestPath: string): Promise<LocalizedText | undefined> {
  if (value === undefined) return undefined;
  const one = async (text: unknown): Promise<string> => {
    if (typeof text !== "string") throw new ConfigError(`${manifestPath}: "longDescription" must be text, or one text per locale.`);
    if (!/\.(md|txt)$/i.test(text)) return text.trim();
    const file = within(root, text, "longDescription", manifestPath);
    return (await readFile(file, "utf8").catch(() => {
      throw new ConfigError(`${manifestPath}: longDescription "${text}" cannot be read.`);
    })).trim();
  };
  const result: LocalizedText =
    typeof value === "string"
      ? await one(value)
      : Object.fromEntries(await Promise.all(Object.entries(value as Record<string, unknown>).map(async ([tag, text]) => [tag, await one(text)])));
  if (!isText(result, MAX_LONG_DESCRIPTION)) {
    throw new ConfigError(`${manifestPath}: "longDescription" must be 1-${MAX_LONG_DESCRIPTION} characters in every locale.`);
  }
  return result;
}

export async function readPluginProject(directory: string): Promise<PluginProject> {
  const root = resolve(directory);
  const manifestPath = join(root, "plugin.json");
  const isDirectory = await stat(root).then((entry) => entry.isDirectory(), () => false);
  if (!isDirectory) throw new ConfigError(`${root} is not a directory.`);

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new ConfigError(
      `${root} has no plugin.json. Point marketplace serve at a plugin project (the dev kit's templates/plugin is one), ` +
        "or run it from inside one.",
    );
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`${manifestPath} is not a JSON object: ${(error as Error).message}.`);
  }

  if (manifest.system !== undefined) {
    throw new ConfigError(
      `${manifestPath} declares "system" requirements. A marketplace bundle runs without installing anything into the ` +
        "engine image, so remove the block and bundle what the plugin needs instead.",
    );
  }
  const namespace = manifest.namespace ?? manifest.name;
  if (typeof namespace !== "string" || !IDENTIFIER.test(namespace)) {
    throw new ConfigError(
      `${manifestPath} needs a "namespace" (or "name") made of letters, digits, ".", "_" and "-", starting with a ` +
        "letter or digit. It prefixes every tool and hook name and must never change.",
    );
  }
  if (RESERVED_NAMESPACES.has(namespace)) {
    throw new ConfigError(`${manifestPath}: the namespace "${namespace}" is reserved by the engine; choose another.`);
  }
  if (typeof manifest.version !== "string" || valid(manifest.version) === null) {
    throw new ConfigError(`${manifestPath} needs a SemVer "version" such as "0.1.0"; bump it for every change you serve.`);
  }
  if (typeof manifest.engine !== "string" || validRange(manifest.engine) === null) {
    throw new ConfigError(`${manifestPath} needs an "engine" SemVer range such as ">=1.3.0".`);
  }
  const oauthProviders = manifest.oauthProviders ?? [];
  if (!Array.isArray(oauthProviders) || oauthProviders.some((entry) => typeof entry?.name !== "string")) {
    throw new ConfigError(`${manifestPath}: "oauthProviders" must be a list of providers, each with a "name".`);
  }

  const toolsDir = typeof manifest.toolsDir === "string" ? manifest.toolsDir : "tools";
  const hooksDir = typeof manifest.hooksDir === "string" ? manifest.hooksDir : "hooks";
  within(root, toolsDir, "toolsDir", manifestPath, true);
  within(root, hooksDir, "hooksDir", manifestPath, true);
  const toolFiles = await sourceFiles(root, toolsDir, "tool");
  const hookFiles = await sourceFiles(root, hooksDir, "hook");
  if (toolFiles.length + hookFiles.length === 0) {
    throw new ConfigError(`${root} has no *.tool.ts in ${toolsDir}/ and no *.hook.ts in ${hooksDir}/.`);
  }

  const optionalText = (key: string, max?: number): LocalizedText | undefined => {
    const value = manifest[key];
    if (value === undefined || value === "") return undefined;
    if (!isText(value, max)) throw new ConfigError(`${manifestPath}: "${key}" must be text, or one text per BCP 47 tag (en-US, it-IT).`);
    return value;
  };
  const name = optionalText("displayName") ?? humanize(namespace);
  const summary = optionalText("description") ?? `${humanize(namespace)}, served from a local build.`;
  const category = optionalText("category", 40);
  const publisher = manifest.publisher;
  if (publisher !== undefined && (typeof publisher !== "string" || publisher.trim() === "" || publisher.length > 80)) {
    throw new ConfigError(`${manifestPath}: "publisher" must be 1-80 characters.`);
  }
  const documentationUrl = manifest.documentationUrl;
  if (documentationUrl !== undefined && (typeof documentationUrl !== "string" || !/^https:\/\/\S+$/.test(documentationUrl))) {
    throw new ConfigError(`${manifestPath}: "documentationUrl" must be an https:// URL.`);
  }
  const longDescription = await readLongDescription(root, manifest.longDescription, manifestPath);
  const icon = await readIcon(root, manifest.icon, manifestPath);

  return {
    root,
    namespace,
    version: manifest.version,
    engineRange: manifest.engine,
    oauthProviders: oauthProviders as PluginProject["oauthProviders"],
    toolFiles,
    hookFiles,
    presentation: {
      name,
      summary,
      ...(longDescription === undefined ? {} : { longDescription }),
      ...(icon === undefined ? {} : { icon }),
      ...(category === undefined ? {} : { category }),
      ...(publisher === undefined ? {} : { publisher: publisher as string }),
      ...(documentationUrl === undefined ? {} : { documentationUrl: documentationUrl as string }),
    },
  };
}
