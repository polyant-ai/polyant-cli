// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, it, expect, vi, afterEach } from "vitest";
import { KEY_HEADER, WORKSPACE_HEADER, extractMessage, request, requestStream, statusToExitCode } from "./client.js";
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

    expect(res).toEqual({ status: 200, raw: '{"instances":[]}', body: { instances: [] } });
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

  it("should_select_the_active_workspace_with_a_header_when_one_is_given", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await request(TARGET, { path: "/api/instances", workspaceId: "ws-1" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>)[WORKSPACE_HEADER]).toBe("ws-1");
  });

  it("should_omit_the_workspace_header_when_no_workspace_is_selected", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await request(TARGET, { path: "/health" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect((init.headers as Record<string, string>)[WORKSPACE_HEADER]).toBeUndefined();
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
    // A 204 is a null-body status: the Fetch spec requires a literal `null` body
    // here, not merely an empty string — Node's Response constructor throws
    // otherwise ("Invalid response status code 204").
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    expect(await request(TARGET, { path: "/api/instances/acme", method: "DELETE" })).toEqual({
      status: 204,
      raw: "",
      body: null,
    });
  });

  it("should_return_raw_text_when_the_body_is_not_json", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("plain", { status: 200 })));

    expect(await request(TARGET, { path: "/health" })).toEqual({
      status: 200,
      raw: "plain",
      body: "plain",
    });
  });

  it("should_preserve_the_response_text_verbatim_so_large_numbers_survive", async () => {
    // JSON.parse would round this; `raw` is what `api` prints.
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"id":12345678901234567890}', { status: 200 })));

    expect((await request(TARGET, { path: "/x" })).raw).toBe('{"id":12345678901234567890}');
  });

  it("should_ask_fetch_not_to_follow_redirects", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await request(TARGET, { path: "/api/instances" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.redirect).toBe("manual");
  });

  // Following a 3xx would re-send X-Polyant-Key to the Location host, because
  // the fetch spec strips Authorization across origins but not a custom header.
  it("should_refuse_to_follow_a_redirect_and_name_the_location", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://idp.example/login" } })),
    );

    await expect(request(TARGET, { path: "/api/instances" })).rejects.toThrow(/was redirected \(302 to https:\/\/idp\.example\/login\)/);
    await expect(request(TARGET, { path: "/api/instances" })).rejects.toThrow(/login proxy/);
  });

  it("should_reject_a_path_that_does_not_start_with_a_slash", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(request(TARGET, { path: "api/instances" })).rejects.toThrow(/must start with "\/"/);
  });
});

function sseResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<{ data: string }>): Promise<string[]> {
  const seen: string[] = [];
  for await (const event of stream) seen.push(event.data);
  return seen;
}

describe("requestStream", () => {
  it("should_yield_each_data_event_and_drop_heartbeat_comments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(': connected\n\ndata: {"id":"1"}\n\n: ping\n\ndata: {"id":"2"}\n\n')),
    );

    const stream = await requestStream(TARGET, { path: "/api/activity-stream/live", timeoutMs: 0 });

    expect(stream.status).toBe(200);
    expect(await collect(stream.events)).toEqual(['{"id":"1"}', '{"id":"2"}']);
  });

  it("should_join_a_multi_line_data_payload_without_reserialising_it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse("data: line one\ndata: line two\n\n")));

    const stream = await requestStream(TARGET, { path: "/api/activity-stream/live", timeoutMs: 0 });

    expect(await collect(stream.events)).toEqual(["line one\nline two"]);
  });

  it("should_send_the_same_headers_and_still_refuse_redirects", async () => {
    const fetchMock = vi.fn(async () => sseResponse(""));
    vi.stubGlobal("fetch", fetchMock);

    await requestStream(TARGET, { path: "/api/activity-stream/live", workspaceId: "ws-1", timeoutMs: 0 });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers[KEY_HEADER]).toBe("pk_uuid_secret");
    expect(headers[WORKSPACE_HEADER]).toBe("ws-1");
    expect(init.redirect).toBe("manual");
    // A follow stream must not carry a deadline that would abort it mid-run.
    expect(init.signal).toBeUndefined();
  });

  it("should_refuse_a_redirected_stream_before_reading_any_event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://idp.example/login" } })),
    );

    await expect(requestStream(TARGET, { path: "/api/activity-stream/live", timeoutMs: 0 }))
      .rejects.toThrow(/was redirected \(302 to https:\/\/idp\.example\/login\)/);
  });

  it("should_map_a_rejected_subscription_to_its_status_and_message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(503, { error: "Too many concurrent activity-stream subscribers", message: "Service Unavailable" })),
    );

    const failure = requestStream(TARGET, { path: "/api/activity-stream/live", timeoutMs: 0 });
    await expect(failure).rejects.toThrow(RemoteError);
    await expect(failure).rejects.toMatchObject({ code: ExitCode.Remote, status: 503 });
  });

  it("should_keep_the_default_deadline_when_no_timeout_is_requested", async () => {
    const fetchMock = vi.fn(async () => sseResponse(""));
    vi.stubGlobal("fetch", fetchMock);

    await requestStream(TARGET, { path: "/api/activity-stream/live" });

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
