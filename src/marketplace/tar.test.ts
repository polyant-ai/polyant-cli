// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTarGz } from "./tar.js";

const FILES = [
  { name: "plugin.json", bytes: Buffer.from('{"pluginId":"p"}\n') },
  { name: "definitions.json", bytes: Buffer.from('{"tools":[],"hooks":[]}\n') },
  // Exactly one block, and one byte over: the padding edge cases.
  { name: "worker.mjs", bytes: Buffer.alloc(513, "x") },
];

describe("createTarGz", () => {
  it("is reproducible: the same files give the same bytes", () => {
    expect(createTarGz(FILES).equals(createTarGz(FILES))).toBe(true);
  });

  it("is read back by the system tar as the same flat files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polyant-tar-"));
    try {
      await writeFile(join(dir, "bundle.tar.gz"), createTarGz(FILES));
      const listing = execFileSync("tar", ["-tzf", join(dir, "bundle.tar.gz")], { encoding: "utf8" });
      expect(listing.trim().split("\n")).toEqual(["plugin.json", "definitions.json", "worker.mjs"]);
      execFileSync("tar", ["-xzf", join(dir, "bundle.tar.gz"), "-C", dir]);
      for (const file of FILES) expect((await readFile(join(dir, file.name))).equals(file.bytes)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a nested path", () => {
    expect(() => createTarGz([{ name: "a/b", bytes: Buffer.alloc(1) }])).toThrow(/unsupported entry name/);
  });
});
