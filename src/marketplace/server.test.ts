// SPDX-License-Identifier: Apache-2.0
import { request } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerMatches, resolveServedFile, startMarketplaceServer, type RunningServer } from "./server.js";

/**
 * Raw requests, not `fetch`: fetch normalises `..` and `%2e%2e` away before
 * sending, which would test the client instead of the server.
 */
function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

let root: string;
let outDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "polyant-server-"));
  outDir = join(root, "out");
  await mkdir(join(outDir, "v1", "artifacts", "p", "1.0.0"), { recursive: true });
  await writeFile(join(outDir, "v1", "catalog.json"), '{"schemaVersion":1}');
  await writeFile(join(outDir, "v1", "artifacts", "p", "1.0.0", "x.tar.gz"), "bytes");
  await writeFile(join(outDir, "outside-v1.txt"), "private");
  await writeFile(join(root, "secret.txt"), "private");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveServedFile", () => {
  it("serves only files under v1/", () => {
    expect(resolveServedFile("/srv/out", "/v1/catalog.json")).toBe("/srv/out/v1/catalog.json");
    expect(resolveServedFile("/srv/out", "/v1/catalog.json?x=1")).toBe("/srv/out/v1/catalog.json");
    expect(resolveServedFile("/srv/out", "/outside-v1.txt")).toBeUndefined();
    expect(resolveServedFile("/srv/out", "/v1/")).toBeUndefined();
    expect(resolveServedFile("/srv/out", "/v1")).toBeUndefined();
  });

  it.each([
    "/v1/../secret.txt",
    "/v1/../../secret.txt",
    "/v1/%2e%2e/secret.txt",
    "/v1/%2E%2E/%2e%2e/secret.txt",
    "/v1/..%2fsecret.txt",
    "/v1/..%5csecret.txt",
    "/v1/artifacts/./p",
    "/v1//etc/passwd",
    "/v1/%00",
    "/v1/%zz",
  ])("refuses %s", (path) => {
    expect(resolveServedFile("/srv/out", path)).toBeUndefined();
  });
});

describe("bearerMatches", () => {
  it("accepts only the exact token, as a Bearer credential", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(bearerMatches("Bearer s3cre", "s3cret")).toBe(false);
    expect(bearerMatches("Bearer s3cret2", "s3cret")).toBe(false);
    expect(bearerMatches("Basic s3cret", "s3cret")).toBe(false);
    expect(bearerMatches("s3cret", "s3cret")).toBe(false);
    expect(bearerMatches(undefined, "s3cret")).toBe(false);
  });
});

describe("the marketplace server", () => {
  let open: RunningServer;
  let locked: RunningServer;

  beforeAll(async () => {
    open = await startMarketplaceServer({ outDir, host: "127.0.0.1", port: 0 });
    locked = await startMarketplaceServer({ outDir, host: "127.0.0.1", port: 0, token: "s3cret" });
  });

  afterAll(async () => {
    await open.close();
    await locked.close();
  });

  it("binds to loopback", () => {
    expect(open.url).toBe(`http://127.0.0.1:${open.port}`);
  });

  it("serves the catalogue and an artifact", async () => {
    expect(await get(open.port, "/v1/catalog.json")).toEqual({ status: 200, body: '{"schemaVersion":1}' });
    expect(await get(open.port, "/v1/artifacts/p/1.0.0/x.tar.gz")).toEqual({ status: 200, body: "bytes" });
  });

  // An unsigned marketplace publishes no signature; the engine does not ask for one.
  it("answers 404 for the signature and anything else absent", async () => {
    expect((await get(open.port, "/v1/catalog.sig.json")).status).toBe(404);
    expect((await get(open.port, "/v1/mcp-catalog.json")).status).toBe(404);
    expect((await get(open.port, "/")).status).toBe(404);
  });

  it("never serves a file outside v1/", async () => {
    for (const path of ["/v1/../secret.txt", "/v1/../../secret.txt", "/v1/%2e%2e/outside-v1.txt", "/v1/..%2f..%2fsecret.txt", "/outside-v1.txt"]) {
      const response = await get(open.port, path);
      expect(response.status, path).toBe(404);
      expect(response.body, path).not.toContain("private");
    }
  });

  it("is read-only", async () => {
    expect((await get(open.port, "/v1/catalog.json", {}, "POST")).status).toBe(405);
    expect(await get(open.port, "/v1/catalog.json", {}, "HEAD")).toEqual({ status: 200, body: "" });
  });

  it("requires the bearer token when one is set", async () => {
    expect((await get(locked.port, "/v1/catalog.json")).status).toBe(401);
    expect((await get(locked.port, "/v1/catalog.json", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await get(locked.port, "/v1/catalog.json", { authorization: "Bearer s3cret" })).status).toBe(200);
    // Before the path is even looked at: a probe learns nothing without the token.
    expect((await get(locked.port, "/v1/../secret.txt")).status).toBe(401);
  });
});
