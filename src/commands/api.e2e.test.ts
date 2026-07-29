// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
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
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    out = [];
    loadWorkspaceConfig.mockResolvedValue(undefined);
    resolveTarget.mockReturnValue(TARGET);
    fetchMock = vi.fn(async () => new Response('{"enabled":["webSearch"]}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    loadWorkspaceConfig.mockReset();
    resolveTarget.mockReset();
  });

  // `@package.json` is used as the body file so the test needs no fixture and
  // writes nothing. Like the EISDIR test in config.test.ts it assumes vitest
  // runs from the repo root.
  it("should_send_the_method_key_and_serialised_body_when_data_comes_from_a_file", async () => {
    await apiCommand.run(["PATCH", "/api/instances/acme/tools", "--data", "@package.json"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://localhost:4000/api/instances/acme/tools");
    expect(init.method).toBe("PATCH");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Polyant-Key"]).toBe("pk_uuid_secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "@polyant-ai/cli" });
    expect(out.join("")).toBe('{"enabled":["webSearch"]}\n');
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
