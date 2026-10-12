// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { devContext, devHarness, leaf } from "./dev.test-harness.js";

const EXPECTED = [
  "/work/tools/package.json",
  "/work/tools/tsconfig.json",
  "/work/tools/.gitignore",
  "/work/tools/tools/local-echo.tool.ts",
];

describe("dev init", () => {
  it("writes the four scaffold files under the current directory", async () => {
    const h = devHarness([]);

    await leaf(h.command, ["init"])([], devContext({ yes: true }));

    expect([...h.files.keys()].sort()).toEqual([...EXPECTED].sort());
    expect(h.out.join("")).toContain("/work/tools/tools/local-echo.tool.ts");
  });

  it("resolves a relative directory argument against the current one", async () => {
    const h = devHarness([]);

    await leaf(h.command, ["init"])(["sub/dir"], devContext({ yes: true }));

    expect(h.files.has("/work/tools/sub/dir/package.json")).toBe(true);
  });

  /**
   * The two dependencies are not decoration: `tsx` is what makes a `*.tool.ts`
   * importable at all, and the SDK has to resolve from THIS project because
   * that is where the tool file's bare specifier is resolved from.
   */
  it("declares the SDK and tsx in the project it scaffolds", async () => {
    const h = devHarness([]);

    await leaf(h.command, ["init"])([], devContext({ yes: true }));

    const manifest = JSON.parse(h.files.get("/work/tools/package.json") as string) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(manifest.dependencies["@polyant-ai/plugin-sdk"]).toMatch(/^git\+https:.*#v\d+\.\d+\.\d+$/);
    // `dev connect` serves hooks (SDK 1.8) and bridges `ctx.artifacts`
    // (SDK 1.9): a tag below that scaffolds a project whose tools find no
    // `ctx.artifacts` under dev mode. The floor moves with the capability,
    // never below it.
    const tag = /#v(\d+)\.(\d+)\.\d+$/.exec(manifest.dependencies["@polyant-ai/plugin-sdk"]);
    expect(tag).not.toBeNull();
    const [major, minor] = [Number(tag?.[1]), Number(tag?.[2])];
    expect(major > 1 || (major === 1 && minor >= 9)).toBe(true);
    expect(manifest.dependencies.zod).toBeDefined();
    expect(manifest.devDependencies.tsx).toBeDefined();
    expect(manifest.scripts.dev).toBe("polyant-cli dev connect <agent-slug> --watch");
  });

  it("bakes the agent slug into the dev script when given one", async () => {
    const h = devHarness([]);

    await leaf(h.command, ["init"])([".", "--agent", "acme"], devContext({ yes: true }));

    const manifest = JSON.parse(h.files.get("/work/tools/package.json") as string) as { scripts: Record<string, string> };
    expect(manifest.scripts.dev).toBe("polyant-cli dev connect acme --watch");
    // The placeholder reminder is only for the scaffold that still carries one.
    expect(h.err.join("")).not.toContain("after replacing");
  });

  it("names every file already present rather than overwriting one", async () => {
    const h = devHarness([]);
    h.files.set("/work/tools/package.json", "{}");
    h.files.set("/work/tools/tsconfig.json", "{}");

    await expect(leaf(h.command, ["init"])([], devContext({ yes: true }))).rejects.toThrow(
      /already contains package\.json, tsconfig\.json; pass --force/,
    );
    // Nothing else was written: a partial scaffold is worse than none.
    expect([...h.files.keys()].sort()).toEqual(["/work/tools/package.json", "/work/tools/tsconfig.json"]);
  });

  it("replaces with --force, and says which files it replaces", async () => {
    const h = devHarness([]);
    h.files.set("/work/tools/package.json", "{}");

    await leaf(h.command, ["init"])([".", "--force"], devContext({ yes: true }));

    expect(h.err.join("")).toContain("Replace package.json.");
    expect(h.err.join("")).toContain("Write tsconfig.json.");
    expect(h.files.get("/work/tools/package.json")).toContain("@polyant-ai/plugin-sdk");
  });

  it("writes nothing under --dry-run, having shown the recap", async () => {
    const h = devHarness([]);

    await leaf(h.command, ["init"])([], devContext({ dryRun: true }));

    expect(h.files.size).toBe(0);
    expect(h.err.join("")).toContain("Scaffold a Polyant dev-tools project in /work/tools");
  });

  it("rejects an unknown option instead of taking it for a directory", async () => {
    const h = devHarness([]);

    await expect(leaf(h.command, ["init"])(["--agnt", "acme"], devContext({ yes: true }))).rejects.toThrow(
      /Unknown dev init option --agnt/,
    );
  });
});
