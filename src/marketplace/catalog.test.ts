// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../exit.js";
import { artifactPath, type BuiltBundle, type Release } from "./bundle.js";
import { mergeCatalog, nextGeneratedAt, readPreviousCatalog, type BuiltPlugin, type Catalog } from "./catalog.js";

/**
 * `fixtures/official-catalog.json` is one entry of the official catalogue as
 * the official publisher's own scripts generate it (polyant-marketplace,
 * `buildCatalog` over `catalog/exelab.sql.json`), a catalogue every engine
 * accepts. The catalogue served here has to be the same shape.
 */
const FIXTURE = JSON.parse(await readFile(new URL("./fixtures/official-catalog.json", import.meta.url), "utf8")) as Catalog;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function built(version: string, sha256: string, at = "2026-11-01T00:00:00.000Z"): BuiltPlugin {
  const release: Release = {
    version,
    namespace: "acme",
    engineRange: ">=1.3.0",
    artifactPath: artifactPath("acme", version, sha256),
    sha256,
    compressedBytes: 10,
    expandedBytes: 30,
    fileCount: 3,
    status: "published",
    changelogSummary: "",
    publishedAt: at,
    capabilityDescriptions: { "acme:lookup": "Looks something up." },
    hookDescriptions: { "acme:seed": "Seeds state." },
    secretLabels: { acme_key: { "en-US": "Acme key" } },
    permissions: {
      tools: ["acme:lookup"],
      hooks: ["acme:seed"],
      requiredSecrets: ["acme_key"],
      oauthProviders: [],
      requiredKnowledge: [],
      mayHalt: true,
      mayMutateResponse: true,
    },
  };
  const bundle: BuiltBundle = { pluginId: "acme", bytes: Buffer.alloc(10), release };
  return { bundle, presentation: { name: { "en-US": "Acme" }, summary: "Looks things up." } };
}

/** Text a person reads is one string or one string per locale; either spelling is the same kind. */
const LOCALIZED = new Set(["name", "summary", "longDescription", "category", "changelogSummary"]);

function kindOf(key: string, value: unknown): string {
  if (LOCALIZED.has(key) && (typeof value === "string" || (typeof value === "object" && value !== null && !Array.isArray(value)))) return "text";
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

describe("the generated catalogue", () => {
  it("has the shape of a catalogue the official publisher generates", () => {
    const { catalog } = mergeCatalog(undefined, [built("1.0.0", SHA_A)], new Date("2026-11-26T10:00:00.000Z"));
    const official = FIXTURE.plugins[0];
    const ours = catalog.plugins[0];

    expect(Object.keys(catalog).sort()).toEqual(Object.keys(FIXTURE).sort());
    expect(catalog.schemaVersion).toBe(FIXTURE.schemaVersion);
    expect(catalog.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    for (const key of Object.keys(ours)) {
      expect(Object.keys(official), `plugin key ${key}`).toContain(key);
      expect(kindOf(key, ours[key as keyof typeof ours]), key).toBe(kindOf(key, official[key as keyof typeof official]));
    }

    const officialRelease = official.releases[0] as unknown as Record<string, unknown>;
    const release = ours.releases[0] as unknown as Record<string, unknown>;
    // The official entry predates `hookDescriptions` and has no labelled secrets;
    // both are optional maps of the same kind as `capabilityDescriptions`.
    const known = new Set([...Object.keys(officialRelease), "hookDescriptions", "secretLabels"]);
    for (const key of Object.keys(release)) {
      expect(known, `release key ${key}`).toContain(key);
      const reference = officialRelease[key] ?? officialRelease.capabilityDescriptions;
      expect(kindOf(key, release[key]), key).toBe(kindOf(key, reference));
    }
    for (const key of ["version", "namespace", "engineRange", "artifactPath", "sha256", "compressedBytes", "expandedBytes", "fileCount", "status", "changelogSummary", "permissions"]) {
      expect(release, key).toHaveProperty(key);
    }
    expect(Object.keys(release.permissions as object).sort()).toEqual(Object.keys(officialRelease.permissions as object).sort());
    expect(release.artifactPath).toBe(`/v1/artifacts/acme/1.0.0/${SHA_A}.tar.gz`);
    expect(officialRelease.artifactPath).toMatch(/^\/v1\/artifacts\/exelab\.sql\/[^/]+\/[a-f0-9]{64}\.tar\.gz$/);
  });

  it("keeps earlier versions listed when a new one is built", () => {
    const first = mergeCatalog(undefined, [built("1.0.0", SHA_A)], new Date("2026-11-26T10:00:00.000Z")).catalog;
    const second = mergeCatalog(first, [built("1.1.0", SHA_B)], new Date("2026-11-26T11:00:00.000Z"));
    expect(second.catalog.plugins).toHaveLength(1);
    expect(second.catalog.plugins[0].releases.map((release) => release.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(second.prepared).toEqual([{ pluginId: "acme", version: "1.1.0", sha256: SHA_B, unchanged: false }]);
  });

  it("keeps a plugin from an earlier run that was not built this time", () => {
    const first = mergeCatalog(undefined, [built("1.0.0", SHA_A)], new Date()).catalog;
    const second = mergeCatalog(first, [], new Date()).catalog;
    expect(second.plugins.map((plugin) => plugin.pluginId)).toEqual(["acme"]);
  });

  it("treats the same version with the same digest as unchanged, publishedAt included", () => {
    const first = mergeCatalog(undefined, [built("1.0.0", SHA_A, "2026-11-01T00:00:00.000Z")], new Date()).catalog;
    const second = mergeCatalog(first, [built("1.0.0", SHA_A, "2026-11-20T00:00:00.000Z")], new Date());
    expect(second.prepared[0].unchanged).toBe(true);
    expect(second.catalog.plugins[0].releases).toEqual(first.plugins[0].releases);
  });

  it("refuses the same version with a different digest, and says to bump it", () => {
    const first = mergeCatalog(undefined, [built("1.0.0", SHA_A)], new Date()).catalog;
    expect(() => mergeCatalog(first, [built("1.0.0", SHA_B)], new Date())).toThrow(ConfigError);
    expect(() => mergeCatalog(first, [built("1.0.0", SHA_B)], new Date())).toThrow(/acme@1\.0\.0 was already served.*bump "version"/s);
  });

  it("refuses two projects with one namespace", () => {
    expect(() => mergeCatalog(undefined, [built("1.0.0", SHA_A), built("1.1.0", SHA_B)], new Date())).toThrow(/namespace "acme"/);
  });
});

describe("generatedAt", () => {
  it("is the current time when that is later than the previous catalogue", () => {
    expect(nextGeneratedAt("2026-11-26T10:00:00.000Z", new Date("2026-11-26T11:00:00.000Z")).toISOString()).toBe("2026-11-26T11:00:00.000Z");
    expect(nextGeneratedAt(undefined, new Date("2026-11-26T11:00:00.000Z")).toISOString()).toBe("2026-11-26T11:00:00.000Z");
  });

  // The engine refuses an older catalogue, and an equal one with other bytes, as a rollback.
  it("still grows when the clock went backwards or did not move", () => {
    expect(nextGeneratedAt("2026-11-26T10:00:00.000Z", new Date("2026-11-26T09:00:00.000Z")).toISOString()).toBe("2026-11-26T10:00:00.001Z");
    expect(nextGeneratedAt("2026-11-26T10:00:00.000Z", new Date("2026-11-26T10:00:00.000Z")).toISOString()).toBe("2026-11-26T10:00:00.001Z");
  });

  describe("across restarts", () => {
    let dir: string;
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("is read back from the output directory", async () => {
      dir = await mkdtemp(join(tmpdir(), "polyant-catalog-"));
      const frozen = new Date("2026-11-26T10:00:00.000Z");
      let previous: string | undefined;
      const seen: string[] = [];
      for (let run = 0; run < 3; run += 1) {
        const loaded = await readPreviousCatalog(dir);
        const { catalog } = mergeCatalog(loaded, [built("1.0.0", SHA_A)], nextGeneratedAt(loaded?.generatedAt, frozen));
        await mkdir(join(dir, "v1"), { recursive: true });
        await writeFile(join(dir, "v1", "catalog.json"), JSON.stringify(catalog));
        if (previous !== undefined) expect(Date.parse(catalog.generatedAt)).toBeGreaterThan(Date.parse(previous));
        previous = catalog.generatedAt;
        seen.push(catalog.generatedAt);
      }
      expect(new Set(seen).size).toBe(3);
    });

    it("refuses an output directory whose catalogue is not one", async () => {
      dir = await mkdtemp(join(tmpdir(), "polyant-catalog-"));
      await mkdir(join(dir, "v1"), { recursive: true });
      await writeFile(join(dir, "v1", "catalog.json"), "{not json");
      await expect(readPreviousCatalog(dir)).rejects.toThrow(/cannot be read as a catalogue/);
    });
  });
});
