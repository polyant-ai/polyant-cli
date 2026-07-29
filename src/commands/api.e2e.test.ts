// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The HTTP client is deliberately NOT mocked here — only target resolution is.
const loadWorkspaceConfig = vi.fn();
const resolveTarget = vi.fn();

vi.mock("../config.js", () => ({ loadWorkspaceConfig, resolveTarget }));

const { apiCommand } = await import("./api.js");

const TARGET = {
  name: "dev",
  baseUrl: "http://localhost:4000",
  key: "pk_uuid_secret",
  prod: false,
};

describe("api end to end", () => {
  let out: string[];
  let err: string[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    out = [];
    err = [];
    loadWorkspaceConfig.mockResolvedValue(undefined);
    resolveTarget.mockReturnValue(TARGET);
    fetchMock = vi.fn(async () => new Response('{"enabled":["webSearch"]}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  function approved() {
    return { path: ["api"], global: { json: false, yes: true, dryRun: false } } as never;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    loadWorkspaceConfig.mockReset();
    resolveTarget.mockReset();
  });

  // `@package.json` is used as the body file so the test needs no fixture and
  // writes nothing. Like the EISDIR test in config.test.ts it assumes vitest
  // runs from the repo root.
  it("should_send_the_method_key_and_the_file_body_unchanged", async () => {
    await apiCommand.run(["PATCH", "/api/instances/acme/tools", "--data", "@package.json"], approved());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://localhost:4000/api/instances/acme/tools");
    expect(init.method).toBe("PATCH");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Polyant-Key"]).toBe("pk_uuid_secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.redirect).toBe("manual");
    // Byte-for-byte, not merely equivalent: re-serialising the caller's own JSON
    // would lose integer precision, turn `1.0` into `1`, and drop key order.
    expect(init.body).toBe(await readFile("package.json", "utf8"));
    expect(out.join("")).toBe('{"enabled":["webSearch"]}\n');
  });

  it("should_forward_a_stdin_body_unchanged_and_name_only_its_source_in_the_recap", async () => {
    const payload = '{"big":10000000000000000001,"exact":1.0}';
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      Readable.from([Buffer.from(payload, "utf8")]) as unknown as typeof process.stdin,
    );

    await apiCommand.run(["POST", "/api/instances", "--data", "-"], approved());

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.body).toBe(payload);
    // The recap must describe the payload, never print or parse it.
    const recap = err.join("");
    expect(recap).toContain(`Request body: stdin (${payload.length} bytes, forwarded unchanged).`);
    expect(recap).not.toContain("10000000000000000001");
  });

  it("should_reject_a_malformed_body_locally_without_sending_it", async () => {
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      Readable.from([Buffer.from("{not json", "utf8")]) as unknown as typeof process.stdin,
    );

    await expect(apiCommand.run(["POST", "/api/instances", "--data", "-"], approved()))
      .rejects.toThrow(/--data is not valid JSON/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should_append_query_parameters_to_the_request_url", async () => {
    await apiCommand.run([
      "GET",
      "/api/conversations",
      "--query",
      "instanceId=acme",
      "--query",
      "limit=5",
    ]);

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.get("instanceId")).toBe("acme");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("should_refuse_the_call_and_print_nothing_when_the_target_redirects", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://idp.example/login" } }),
    );

    await expect(apiCommand.run(["GET", "/api/instances"])).rejects.toThrow(/login proxy/);
    expect(out.join("")).toBe("");
  });
});
