// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode } from "../exit.js";
import type { CommandContext } from "../command.js";
import { startMarketplaceServer, type RunningServer } from "../marketplace/server.js";
import { createMarketplaceCommand, type MarketplaceDependencies } from "./marketplace.js";

/**
 * Builds a real plugin project with the real esbuild, serves it on a real
 * port, and reads it back over HTTP the way the engine does: catalogue first,
 * then the artifact its entry names, checked against the entry's digest.
 *
 * The plugin is written without the SDK, as the plain objects `defineTool` and
 * `defineHook` return, so the test needs no install; the TypeScript annotation
 * proves the source goes through a TypeScript-capable build.
 */

const TOOL = (reply: string) => `
const parameters: Record<string, unknown> = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
export default {
  name: "echo",
  description: "Echo the text back.\\nSecond line.",
  summary: { "en-US": "Echoes text.", "it-IT": "Ripete il testo." },
  requiredSecrets: [{ key: "echo_key", type: "text", sensitive: true, label: { "en-US": "Echo key" } }],
  inputSchema: parameters,
  execute: async (input: { text: string }) => ({ status: "ok", echoed: input.text, reply: ${JSON.stringify(reply)} }),
};
`;
const HOOK = `
export default { name: "seed", description: "Seeds state.", requiredSecrets: [], handler: async () => undefined };
`;

let root: string;
let plugin: string;
let outDir: string;

async function writeProject(version: string, reply = "one"): Promise<void> {
  await mkdir(join(plugin, "tools"), { recursive: true });
  await mkdir(join(plugin, "hooks"), { recursive: true });
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({ name: "echo-plugin", namespace: "echo", version, engine: ">=1.3.0", displayName: { "en-US": "Echo" }, description: "Echoes." }),
  );
  await writeFile(join(plugin, "tools", "echo.tool.ts"), TOOL(reply));
  await writeFile(join(plugin, "hooks", "seed.hook.ts"), HOOK);
}

interface Session {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly server: Promise<RunningServer>;
  stop(): void;
  readonly done: Promise<void>;
}

function startServe(args: string[], now: Date, env: Record<string, string> = {}, json = false): Session {
  const stdout: string[] = [];
  const stderr: string[] = [];
  // The test may interrupt before the command reaches its wait: remember it.
  let interrupted = false;
  let wake = () => undefined as void;
  let serverReady: (server: RunningServer) => void = () => undefined;
  const server = new Promise<RunningServer>((resolve) => (serverReady = resolve));
  const deps: MarketplaceDependencies = {
    env,
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    cwd: () => root,
    now: () => now,
    waitForInterrupt: () => (interrupted ? Promise.resolve() : new Promise((resolve) => (wake = resolve))),
    startServer: async (options) => {
      const running = await startMarketplaceServer(options);
      serverReady(running);
      return running;
    },
  };
  const serve = createMarketplaceCommand(deps).children!.serve;
  const context: CommandContext = { path: ["marketplace", "serve"], global: { json, yes: false, dryRun: false } };
  const done = serve.run!(args, context);
  // A failure before listening must still settle the server promise for the test.
  done.catch(() => undefined);
  const stop = () => {
    interrupted = true;
    wake();
  };
  return { stdout, stderr, server, stop, done };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "polyant-mkt-e2e-"));
  plugin = join(root, "plugin");
  outDir = join(root, "out");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Each run builds with esbuild and loads the bundle in a child node.
describe("marketplace serve, end to end", { timeout: 30_000 }, () => {
  it("builds, serves the catalogue and an artifact whose digest matches", async () => {
    await writeProject("0.1.0");
    const session = startServe(["plugin", "--out", outDir, "--port", "0"], new Date("2026-11-26T10:00:00.000Z"));
    const server = await Promise.race([session.server, session.done.then(() => Promise.reject(new Error("exited early")))]);

    const catalogResponse = await fetch(`${server.url}/v1/catalog.json`);
    expect(catalogResponse.status).toBe(200);
    expect(catalogResponse.headers.get("content-type")).toBe("application/json");
    const catalog = (await catalogResponse.json()) as { generatedAt: string; plugins: { pluginId: string; name: unknown; releases: Record<string, unknown>[] }[] };
    expect(catalog.generatedAt).toBe("2026-11-26T10:00:00.000Z");
    expect(catalog.plugins).toHaveLength(1);
    const [entry] = catalog.plugins;
    expect(entry.pluginId).toBe("echo");
    expect(entry.name).toEqual({ "en-US": "Echo" });
    const [release] = entry.releases;
    expect(release).toMatchObject({
      version: "0.1.0",
      namespace: "echo",
      engineRange: ">=1.3.0",
      fileCount: 3,
      status: "published",
      changelogSummary: "",
      capabilityDescriptions: { "echo:echo": { "en-US": "Echoes text.", "it-IT": "Ripete il testo." } },
      hookDescriptions: { "echo:seed": "Seeds state." },
      secretLabels: { echo_key: { "en-US": "Echo key" } },
      permissions: {
        tools: ["echo:echo"],
        hooks: ["echo:seed"],
        requiredSecrets: ["echo_key"],
        oauthProviders: [],
        requiredKnowledge: [],
        mayHalt: true,
        mayMutateResponse: true,
      },
    });

    const artifact = await fetch(`${server.url}${String(release.artifactPath)}`);
    expect(artifact.status).toBe(200);
    const bytes = Buffer.from(await artifact.arrayBuffer());
    expect(bytes.length).toBe(release.compressedBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(release.sha256);
    expect((await fetch(`${server.url}/v1/catalog.sig.json`)).status).toBe(404);

    // The bundle itself: the identity the engine compares with the catalogue
    // entry, the definitions as data, and a worker that runs the tool.
    const extracted = join(root, "extracted");
    await mkdir(extracted);
    await writeFile(join(root, "bundle.tar.gz"), bytes);
    execFileSync("tar", ["-xzf", join(root, "bundle.tar.gz"), "-C", extracted]);
    expect(JSON.parse(await readFile(join(extracted, "plugin.json"), "utf8"))).toEqual({
      pluginId: "echo",
      version: "0.1.0",
      namespace: "echo",
      engineRange: ">=1.3.0",
      oauthProviders: [],
    });
    const definitions = JSON.parse(await readFile(join(extracted, "definitions.json"), "utf8"));
    expect(definitions.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo:echo"]);
    expect(Object.keys(definitions.tools[0]).sort()).toEqual(["description", "inputSchema", "name", "requiredSecrets", "summary"]);
    const worker = await import(join(extracted, "worker.mjs"));
    expect(await worker.invokeTool("echo:echo", { text: "hi" }, {})).toEqual({ status: "ok", echoed: "hi", reply: "one" });

    expect(session.stdout.join("")).toBe(`${server.url}\n`);
    expect(session.stderr.join("")).toContain(`ngrok http ${server.port}`);
    session.stop();
    await session.done;
  });

  it("keeps the digest across restarts, refuses changed code under the same version, lists both after a bump", async () => {
    await writeProject("0.1.0", "one");
    const first = startServe(["plugin", "--out", outDir, "--port", "0"], new Date("2026-11-26T10:00:00.000Z"));
    await first.server;
    first.stop();
    await first.done;
    const before = JSON.parse(await readFile(join(outDir, "v1", "catalog.json"), "utf8"));

    // Same sources, clock behind the last catalogue: unchanged, and generatedAt still grows.
    const again = startServe(["plugin", "--out", outDir, "--port", "0"], new Date("2026-11-26T09:00:00.000Z"));
    await again.server;
    again.stop();
    await again.done;
    const after = JSON.parse(await readFile(join(outDir, "v1", "catalog.json"), "utf8"));
    expect(after.plugins[0].releases).toEqual(before.plugins[0].releases);
    expect(after.generatedAt).toBe("2026-11-26T10:00:00.001Z");
    expect(again.stderr.join("")).toContain("unchanged echo@0.1.0");

    await writeProject("0.1.0", "two");
    const refused = startServe(["plugin", "--out", outDir, "--port", "0"], new Date("2026-11-26T11:00:00.000Z"));
    await expect(refused.done).rejects.toMatchObject({ code: ExitCode.Config, message: expect.stringMatching(/bump "version"/) });
    expect(JSON.parse(await readFile(join(outDir, "v1", "catalog.json"), "utf8"))).toEqual(after);

    await writeProject("0.2.0", "two");
    const bumped = startServe(["plugin", "--out", outDir, "--port", "0"], new Date("2026-11-26T12:00:00.000Z"));
    const server = await bumped.server;
    const catalog = (await (await fetch(`${server.url}/v1/catalog.json`)).json()) as { plugins: { releases: { version: string; artifactPath: string }[] }[] };
    expect(catalog.plugins[0].releases.map((release) => release.version)).toEqual(["0.1.0", "0.2.0"]);
    for (const release of catalog.plugins[0].releases) {
      expect((await fetch(`${server.url}${release.artifactPath}`)).status).toBe(200);
    }
    bumped.stop();
    await bumped.done;
  });

  it("requires the token named by --token-env, and refuses an unset variable", async () => {
    await writeProject("0.1.0");
    const unset = startServe(["plugin", "--out", outDir, "--port", "0", "--token-env", "MKT_TOKEN"], new Date());
    await expect(unset.done).rejects.toThrow(/\$MKT_TOKEN is unset/);

    const session = startServe(["plugin", "--out", outDir, "--port", "0", "--token-env", "MKT_TOKEN"], new Date(), { MKT_TOKEN: "s3cret" }, true);
    const server = await session.server;
    expect((await fetch(`${server.url}/v1/catalog.json`)).status).toBe(401);
    expect((await fetch(`${server.url}/v1/catalog.json`, { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
    const summary = JSON.parse(session.stdout.join(""));
    expect(summary).toMatchObject({ url: server.url, catalog: `${server.url}/v1/catalog.json`, plugins: [{ pluginId: "echo", version: "0.1.0", unchanged: false }] });
    session.stop();
    await session.done;
  });

  it("names the manifest mistake before building anything", async () => {
    const cases: [Record<string, unknown> | undefined, RegExp][] = [
      [undefined, /has no plugin\.json/],
      [{ name: "x", version: "1", engine: ">=1.3.0" }, /SemVer "version"/],
      [{ name: "x", version: "1.0.0", engine: "not a range" }, /"engine" SemVer range/],
      [{ name: "x", namespace: "mcp", version: "1.0.0", engine: ">=1.3.0" }, /namespace "mcp" is reserved/],
      [{ name: "has space", version: "1.0.0", engine: ">=1.3.0" }, /needs a "namespace"/],
      [{ name: "x", version: "1.0.0", engine: ">=1.3.0", system: { apk: ["git"] } }, /declares "system"/],
    ];
    for (const [manifest, message] of cases) {
      await rm(plugin, { recursive: true, force: true });
      await writeProject("0.1.0");
      if (manifest === undefined) await rm(join(plugin, "plugin.json"));
      else await writeFile(join(plugin, "plugin.json"), JSON.stringify(manifest));
      const session = startServe(["plugin", "--out", outDir, "--port", "0"], new Date());
      await expect(session.done, String(message)).rejects.toThrow(message);
    }
  });

  it("says to install the project's dependencies when an import does not resolve", async () => {
    await writeProject("0.1.0");
    await writeFile(join(plugin, "tools", "echo.tool.ts"), `import { defineTool } from "@polyant-ai/plugin-sdk";\nexport default defineTool({});\n`);
    const session = startServe(["plugin", "--out", outDir, "--port", "0"], new Date());
    await expect(session.done).rejects.toThrow(/Run `npm install` in/);
  });
});
