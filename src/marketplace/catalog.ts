// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError } from "../exit.js";
import type { BuiltBundle, Release } from "./bundle.js";
import type { PluginProject } from "./project.js";

/**
 * The unsigned catalogue a local marketplace serves at `/v1/catalog.json`, and
 * the output directory that holds it with the artifacts.
 *
 * The output directory is the marketplace's memory between runs. Two engine
 * rules make that necessary:
 *
 *  - A `(pluginId, version)` the engine has verified is immutable: a catalogue
 *    naming another digest for it is refused for that release. So a version
 *    already in the directory with a different digest is refused HERE, with the
 *    fix (bump the version), instead of installing as something else silently.
 *  - A catalogue whose `generatedAt` is older than the one the engine last
 *    accepted is refused as a rollback. So `generatedAt` only ever grows, even
 *    across restarts and a clock that went backwards.
 *
 * Releases served before stay listed, so an Organization that installed one
 * keeps seeing it in the catalogue after the next version is built.
 */

export type PresentationText = PluginProject["presentation"];

export interface CatalogPlugin extends Partial<PresentationText> {
  readonly pluginId: string;
  readonly name: PresentationText["name"];
  readonly summary: PresentationText["summary"];
  readonly releases: readonly Release[];
}

export interface Catalog {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly plugins: readonly CatalogPlugin[];
}

export interface BuiltPlugin {
  readonly bundle: BuiltBundle;
  readonly presentation: PresentationText;
}

export interface PreparedPlugin {
  readonly pluginId: string;
  readonly version: string;
  readonly sha256: string;
  /** True when this exact build was already in the output directory. */
  readonly unchanged: boolean;
}

export const CATALOG_PATH = "v1/catalog.json";

/** A plugin's marketplace id. The namespace is already unique per marketplace and never changes. */
export function pluginIdFor(project: Pick<PluginProject, "namespace">): string {
  return project.namespace;
}

/** Strictly later than the previous catalogue, and the current time when the clock allows it. */
export function nextGeneratedAt(previous: string | undefined, now: Date): Date {
  const floor = previous === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous) + 1;
  return new Date(Math.max(now.getTime(), Number.isNaN(floor) ? Number.NEGATIVE_INFINITY : floor));
}

export async function readPreviousCatalog(outDir: string): Promise<Catalog | undefined> {
  const file = join(outDir, CATALOG_PATH);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const catalog = JSON.parse(raw) as Catalog;
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.plugins) || typeof catalog.generatedAt !== "string") {
      throw new Error("not a marketplace catalogue");
    }
    return catalog;
  } catch (error) {
    throw new ConfigError(
      `${file} cannot be read as a catalogue (${(error as Error).message}). It is generated: move the output directory ` +
        "aside and start again, bumping the version of every plugin an Organization already installed.",
    );
  }
}

/**
 * Folds freshly built plugins into the previous catalogue. Throws when a
 * version already served would change digest. Pure: writes nothing.
 */
export function mergeCatalog(
  previous: Catalog | undefined,
  built: readonly BuiltPlugin[],
  generatedAt: Date,
): { catalog: Catalog; prepared: PreparedPlugin[] } {
  const plugins = new Map<string, CatalogPlugin>((previous?.plugins ?? []).map((plugin) => [plugin.pluginId, plugin]));
  const prepared: PreparedPlugin[] = [];
  const seen = new Set<string>();
  for (const { bundle, presentation } of built) {
    const { pluginId, release } = bundle;
    if (seen.has(pluginId)) throw new ConfigError(`Two plugin projects use the namespace "${release.namespace}"; each needs its own.`);
    seen.add(pluginId);

    const existing = plugins.get(pluginId);
    const served = existing?.releases.find((entry) => entry.version === release.version);
    if (served !== undefined && served.sha256 !== release.sha256) {
      throw new ConfigError(
        `${pluginId}@${release.version} was already served with a different build (sha256 ${served.sha256.slice(0, 12)}…, ` +
          `now ${release.sha256.slice(0, 12)}…). An engine that verified it refuses the same version with other bytes: ` +
          `bump "version" in plugin.json and start again.`,
      );
    }
    if (existing !== undefined && existing.releases.some((entry) => entry.namespace !== release.namespace)) {
      throw new ConfigError(`${pluginId} was served with another namespace; a plugin's namespace never changes.`);
    }
    // The newest build decides how the plugin is presented; the releases keep
    // their own history, an unchanged one with its original publishedAt.
    const releases = served !== undefined ? existing!.releases : [...(existing?.releases ?? []), release];
    plugins.set(pluginId, { pluginId, ...presentation, releases });
    prepared.push({ pluginId, version: release.version, sha256: release.sha256, unchanged: served !== undefined });
  }
  return {
    catalog: { schemaVersion: 1, generatedAt: generatedAt.toISOString(), plugins: [...plugins.values()] },
    prepared,
  };
}

export function catalogBytes(catalog: Catalog): Buffer {
  return Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
}

async function writeAtomically(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

/** Writes the new artifacts, then the catalogue that names them. */
export async function writeMarketplace(outDir: string, catalog: Catalog, built: readonly BuiltPlugin[]): Promise<void> {
  for (const { bundle } of built) {
    await writeAtomically(join(outDir, bundle.release.artifactPath.slice(1)), bundle.bytes);
  }
  await writeAtomically(join(outDir, CATALOG_PATH), catalogBytes(catalog));
}
