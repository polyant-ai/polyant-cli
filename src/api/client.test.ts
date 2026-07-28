// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, it, expect, vi, afterEach } from "vitest";
import { KEY_HEADER, extractMessage, request, statusToExitCode } from "./client.js";
import { ExitCode, RemoteError } from "../exit.js";
import type { ResolvedTarget } from "../config.js";

const TARGET: ResolvedTarget = {
  name: "dev",
  baseUrl: "http://localhost:4000",
  key: "pk_uuid_secret",
  prod: false,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("statusToExitCode", () => {
  it("should_map_429_and_5xx_to_the_remote_code", () => {
    expect(statusToExitCode(429)).toBe(ExitCode.Remote);
    expect(statusToExitCode(500)).toBe(ExitCode.Remote);
    expect(statusToExitCode(503)).toBe(ExitCode.Remote);
  });

  it("should_map_other_4xx_to_the_config_code", () => {
    expect(statusToExitCode(400)).toBe(ExitCode.Config);
    expect(statusToExitCode(401)).toBe(ExitCode.Config);
    expect(statusToExitCode(403)).toBe(ExitCode.Config);
    expect(statusToExitCode(404)).toBe(ExitCode.Config);
  });
});

describe("extractMessage", () => {
  it("should_read_message_and_ignore_error", () => {
    expect(extractMessage(403, { statusCode: 403, message: "Forbidden resource", error: "Forbidden" }))
      .toBe("Forbidden resource");
  });

  it("should_read_message_when_the_envelope_has_no_error_key", () => {
    expect(extractMessage(429, { statusCode: 429, message: "ThrottlerException: Too Many Requests" }))
      .toBe("ThrottlerException: Too Many Requests");
  });

  it("should_join_an_array_message", () => {
    expect(extractMessage(400, { message: ["a: required", "b: too long"] })).toBe("a: required; b: too long");
  });

  it("should_fall_back_to_the_status_when_nothing_is_usable", () => {
    expect(extractMessage(502, {})).toBe("HTTP 502");
    expect(extractMessage(502, null)).toBe("HTTP 502");
  });

  it("should_return_a_plain_text_body_verbatim", () => {
    expect(extractMessage(404, "Not Found")).toBe("Not Found");
  });
});

describe("request", () => {
  it("should_send_the_management_key_header_and_return_the_parsed_body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { instances: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(TARGET, { path: "/api/instances" });

    expect(res).toEqual({ status: 200, body: { instances: [] } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://localhost:4000/api/instances");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)[KEY_HEADER]).toBe("pk_uuid_secret");
  });

  it("should_send_a_bearer_token_instead_of_the_key_when_one_is_given", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await request(TARGET, { path: "/api/instances/acme/chat/stream", method: "POST", bearer: "inst-key", body: {} });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer inst-key");
    expect(headers[KEY_HEADER]).toBeUndefined();
  });

  it("should_serialise_the_body_and_set_the_content_type", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await request(TARGET, { path: "/api/instances", method: "POST", body: { slug: "acme" } });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.body).toBe('{"slug":"acme"}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("should_append_query_parameters", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await request(TARGET, { path: "/api/conversations", query: { instanceId: "acme", limit: "5" } });

    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.searchParams.get("instanceId")).toBe("acme");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("should_raise_a_remote_error_with_the_config_code_on_403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { statusCode: 403, message: "Forbidden resource" })));

    await expect(request(TARGET, { path: "/api/instances" })).rejects.toThrow(RemoteError);
    await expect(request(TARGET, { path: "/api/instances" })).rejects.toMatchObject({
      code: ExitCode.Config,
      status: 403,
      message: "Forbidden resource",
    });
  });

  it("should_raise_the_remote_code_on_429_because_it_is_retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(429, { statusCode: 429, message: "Too Many Requests" })));

    await expect(request(TARGET, { path: "/api/instances" })).rejects.toMatchObject({
      code: ExitCode.Remote,
      status: 429,
    });
  });

  it("should_raise_the_remote_code_when_the_host_is_unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    await expect(request(TARGET, { path: "/api/instances" })).rejects.toMatchObject({
      code: ExitCode.Remote,
    });
    await expect(request(TARGET, { path: "/api/instances" })).rejects.toThrow(/fetch failed/);
  });

  it("should_return_null_for_an_empty_body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    expect(await request(TARGET, { path: "/api/instances/acme", method: "DELETE" })).toEqual({
      status: 204,
      body: null,
    });
  });

  it("should_return_raw_text_when_the_body_is_not_json", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("plain", { status: 200 })));

    expect(await request(TARGET, { path: "/health" })).toEqual({ status: 200, body: "plain" });
  });

  it("should_reject_a_path_that_does_not_start_with_a_slash", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(request(TARGET, { path: "api/instances" })).rejects.toThrow(/must start with "\/"/);
  });
});
