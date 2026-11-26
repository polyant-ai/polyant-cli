// SPDX-License-Identifier: Apache-2.0
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Command, CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { buildBundle } from "../marketplace/bundle.js";
import {
  mergeCatalog,
  nextGeneratedAt,
  pluginIdFor,
  readPreviousCatalog,
  writeMarketplace,
  type BuiltPlugin,
  type Catalog,
  type PreparedPlugin,
} from "../marketplace/catalog.js";
import { readPluginProject } from "../marketplace/project.js";
import { startMarketplaceServer, type MarketplaceServerOptions, type RunningServer } from "../marketplace/server.js";

/**
 * `marketplace serve` — a plugin developer's own marketplace, on this machine.
 *
 * It builds each plugin project into a runtime bundle, writes an UNSIGNED
 * catalogue next to the artifacts, and serves `/v1/*` on localhost. The
 * developer exposes that over HTTPS (ngrok or similar) and registers the URL as
 * an unsigned marketplace of their Organization; the engine then installs the
 * plugin exactly as it would from the official marketplace, digests checked.
 *
 * Nothing here talks to an engine: no target, no key, no workspace. Like
 * `dev connect` it does not terminate until interrupted, and exits 0 then.
 *
 * There is no `--watch`: the engine refuses a version it has verified once with
 * different bytes, so every change has to be a new version anyway, and a
 * restart after bumping it is the whole loop. For edit-and-retry, dev mode is
 * the tool.
 */

export const DEFAULT_PORT = 4870;
export const DEFAULT_OUT_DIR = ".polyant-marketplace";
const HOST = "127.0.0.1";

export interface MarketplaceDependencies {
  readonly env: Record<string, string | undefined>;
  readonly io: { stdout(text: string): void; stderr(text: string): void };
  cwd(): string;
  now(): Date;
  /** Resolves when the operator interrupts the process. */
  waitForInterrupt(): Promise<void>;
  startServer(options: MarketplaceServerOptions): Promise<RunningServer>;
}

export const processMarketplaceDependencies: MarketplaceDependencies = {
  env: process.env,
  io: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
  cwd: () => process.cwd(),
  now: () => new Date(),
  waitForInterrupt: () =>
    new Promise((done) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        done();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    }),
  startServer: startMarketplaceServer,
};

const VALUE_FLAGS = ["--port", "--out", "--token-env"];

function positionals(args: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (VALUE_FLAGS.includes(args[index])) index += 1;
    else if (!args[index].startsWith("--")) found.push(args[index]);
  }
  return found;
}

function portFrom(args: readonly string[]): number {
  const raw = takeValue(args, "--port");
  if (raw === undefined) return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(raw) || Number(raw) > 65535) throw new ConfigError("--port needs a port number between 0 and 65535.");
  return Number(raw);
}

function tokenFrom(args: readonly string[], env: MarketplaceDependencies["env"]): string | undefined {
  const variable = takeValue(args, "--token-env");
  if (variable === undefined) return undefined;
  const value = env[variable]?.trim();
  if (value === undefined || value.length === 0) {
    throw new ConfigError(
      `$${variable} is unset or empty. Export the token the marketplace should require, then pass --token-env ${variable}. ` +
        "There is no --token flag: argv is visible in `ps`.",
    );
  }
  return value;
}

const absolute = (base: string, path: string) => (isAbsolute(path) ? path : resolve(base, path));

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/** Releases listed from earlier runs whose artifact is no longer on disk would 404 on install. */
async function missingArtifacts(outDir: string, catalog: Catalog): Promise<string[]> {
  const missing: string[] = [];
  for (const plugin of catalog.plugins) {
    for (const release of plugin.releases) {
      if (!(await exists(join(outDir, release.artifactPath.slice(1))))) missing.push(`${plugin.pluginId}@${release.version}`);
    }
  }
  return missing;
}

/** Only for the default directory inside a git checkout: elsewhere the operator chose where the build goes. */
async function gitignoreHint(cwd: string): Promise<string | undefined> {
  if (!(await exists(join(cwd, ".git")))) return undefined;
  const ignore = await readFile(join(cwd, ".gitignore"), "utf8").catch(() => "");
  const listed = ignore.split("\n").some((line) => line.trim().replace(/^\//, "").replace(/\/$/, "") === DEFAULT_OUT_DIR);
  return listed ? undefined : `note: ${DEFAULT_OUT_DIR}/ holds generated bundles; add "${DEFAULT_OUT_DIR}/" to .gitignore.`;
}

/** Builds every project and writes the output directory. Exported for the end-to-end test. */
export async function prepareMarketplace(
  directories: readonly string[],
  outDir: string,
  deps: Pick<MarketplaceDependencies, "now" | "io">,
): Promise<{ catalog: Catalog; prepared: PreparedPlugin[] }> {
  // Every project is read before anything is built, so a manifest mistake in
  // the third one does not cost two builds first.
  const projects = await Promise.all(directories.map((directory) => readPluginProject(directory)));
  const previous = await readPreviousCatalog(outDir);
  const now = deps.now();
  const built: BuiltPlugin[] = [];
  for (const project of projects) {
    deps.io.stderr(`building ${project.namespace}@${project.version} from ${project.root}\n`);
    const bundle = await buildBundle(project, pluginIdFor(project), now);
    built.push({ bundle, presentation: project.presentation });
  }
  const result = mergeCatalog(previous, built, nextGeneratedAt(previous?.generatedAt, now));
  // An unchanged build is written again too: same bytes, and it restores an
  // artifact someone deleted from the output directory.
  await writeMarketplace(outDir, result.catalog, built);
  return result;
}

async function serve(args: string[], context: CommandContext | undefined, deps: MarketplaceDependencies): Promise<void> {
  assertKnown(args, { value: VALUE_FLAGS }, "marketplace serve option");
  const cwd = deps.cwd();
  const port = portFrom(args);
  const token = tokenFrom(args, deps.env);
  const out = takeValue(args, "--out");
  const outDir = absolute(cwd, out ?? DEFAULT_OUT_DIR);
  const given = positionals(args);
  const directories = (given.length === 0 ? ["."] : given).map((directory) => absolute(cwd, directory));

  const { catalog, prepared } = await prepareMarketplace(directories, outDir, deps);
  for (const plugin of prepared) {
    deps.io.stderr(
      `${plugin.unchanged ? "unchanged" : "built"} ${plugin.pluginId}@${plugin.version} sha256 ${plugin.sha256}\n`,
    );
  }
  const missing = await missingArtifacts(outDir, catalog);
  if (missing.length > 0) {
    deps.io.stderr(`warning: listed but missing from ${outDir}, so an install of them fails: ${missing.join(", ")}\n`);
  }
  const hint = out === undefined ? await gitignoreHint(cwd) : undefined;
  if (hint !== undefined) deps.io.stderr(`${hint}\n`);

  let server: RunningServer;
  try {
    server = await deps.startServer({ outDir, host: HOST, port, token, log: (line) => deps.io.stderr(`${line}\n`) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new ConfigError(`Port ${port} on ${HOST} is in use; pass --port <n> to choose another.`);
    }
    throw error;
  }

  if (context?.global.json === true) {
    deps.io.stdout(
      `${JSON.stringify({ url: server.url, port: server.port, outDir, catalog: `${server.url}/v1/catalog.json`, generatedAt: catalog.generatedAt, plugins: prepared })}\n`,
    );
  } else {
    deps.io.stdout(`${server.url}\n`);
  }
  deps.io.stderr(
    [
      `Serving an unsigned marketplace from ${outDir} on ${server.url}${token === undefined ? "" : " (Bearer token required)"}.`,
      "",
      `Expose it over HTTPS, for example:  ngrok http ${server.port}`,
      "Then add the https:// origin it prints in Polyant → Organization settings → Plugins → marketplaces, as an",
      "unsigned marketplace" + (token === undefined ? "" : " with the same access token") +
        ". That needs a Platform Admin to have granted your Organization custom marketplaces.",
      "Install from the Organization's plugin catalogue. For every change, bump \"version\" in plugin.json and restart.",
      "Ctrl-C stops serving.",
      "",
    ].join("\n"),
  );

  await deps.waitForInterrupt();
  await server.close();
  deps.io.stderr("stopped.\n");
}

const SERVE_USAGE = `Usage: polyant-cli marketplace serve [<plugin-dir>...] [--port <n>] [--out <dir>] [--token-env <VAR>]

Build each plugin project (default: the current directory) into a runtime bundle,
write an unsigned catalogue, and serve /v1/* on http://127.0.0.1:<port> until
interrupted. Expose it over HTTPS (ngrok http <port>) and add that origin as an
unsigned marketplace in Polyant → Organization settings → Plugins.

  --port <n>          port on 127.0.0.1 (default ${DEFAULT_PORT}; 0 picks a free one)
  --out <dir>         build directory, kept between runs (default ${DEFAULT_OUT_DIR})
  --token-env <VAR>   require Authorization: Bearer <$VAR> on every request

A version already served keeps its digest: change the code, bump "version" in
plugin.json. Earlier versions stay in the catalogue. stdout carries the local
URL (one JSON object with --json); the build log and requests go to stderr.`;

export function createMarketplaceCommand(deps: MarketplaceDependencies = processMarketplaceDependencies): Command {
  return {
    summary: "serve local plugin builds as an unsigned marketplace",
    usage: "Usage: polyant-cli marketplace <action>",
    children: {
      serve: {
        summary: "build plugin projects and serve them as an unsigned marketplace on localhost",
        usage: SERVE_USAGE,
        run: (args, context) => serve(args, context, deps),
      },
    },
  };
}

export const marketplaceCommand = createMarketplaceCommand();
