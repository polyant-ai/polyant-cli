// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResolvedTarget } from "../config.js";

// Only target resolution is mocked. The HTTP client is left real and driven
// through a stubbed `fetch`, so these tests exercise the actual request path
// rather than a stand-in for it. The type import above is erased at compile
// time, so mocking the module does not break it.
const loadWorkspaceConfig = vi.fn();
const resolveTarget = vi.fn();

vi.mock("../config.js", () => ({ loadWorkspaceConfig, resolveTarget }));

const { whoamiCommand, collectWhoami, renderWhoami } = await import("./whoami.js");
type WhoamiReport = Awaited<ReturnType<typeof collectWhoami>>;

const TARGET: ResolvedTarget = {
  name: "prod",
  baseUrl: "https://example.polyant.ai",
  key: "pk_uuid_secret",
  prod: true,
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

describe("collectWhoami", () => {
  it("should_report_reachability_and_agents_when_both_calls_succeed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname === "/health"
          ? jsonResponse(200, { status: "ok", timestamp: "2026-07-28T00:00:00.000Z", service: "polyant" })
          : jsonResponse(200, {
              instances: [
                { slug: "acme", name: "Acme", status: "active", provider: "openai", model: "gpt-5.4", authEnabled: true },
                { slug: "open", name: "Open", status: "active", provider: null, model: null, authEnabled: false },
              ],
            }),
      ),
    );

    const report = await collectWhoami(TARGET);

    expect(report.target).toBe("prod");
    expect(report.prod).toBe(true);
    expect(report.reachable).toBe(true);
    expect(report.service).toBe("polyant");
    expect(report.agents.map((a) => a.slug)).toEqual(["acme", "open"]);
    expect(report.openAgents).toEqual(["open"]);
    expect(report.permissions).toBe("unverified");
  });

  it("should_report_unreachable_without_throwing_when_health_fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const report = await collectWhoami(TARGET);

    expect(report.reachable).toBe(false);
    expect(report.service).toBeNull();
    expect(report.agents).toEqual([]);
  });

  it("should_leave_agents_empty_when_the_key_is_refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname === "/health"
          ? jsonResponse(200, { status: "ok", timestamp: "t", service: "polyant" })
          : jsonResponse(401, { statusCode: 401, message: "Invalid management API key" }),
      ),
    );

    const report = await collectWhoami(TARGET);

    expect(report.reachable).toBe(true);
    expect(report.agents).toEqual([]);
    expect(report.agentsError).toBe("Invalid management API key");
  });

  it("should_report_a_clear_error_when_the_agent_list_has_the_wrong_shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname === "/health"
          ? jsonResponse(200, { status: "ok", timestamp: "t", service: "polyant" })
          : jsonResponse(200, { unexpected: true }),
      ),
    );

    const report = await collectWhoami(TARGET);

    expect(report.agents).toEqual([]);
    expect(report.agentsError).toBe("GET /api/instances did not return an instances array");
  });
});

describe("renderWhoami", () => {
  const report: WhoamiReport = {
    target: "prod",
    baseUrl: "https://example.polyant.ai",
    prod: true,
    reachable: true,
    service: "polyant",
    agents: [{ slug: "acme", status: "active", authEnabled: true }],
    openAgents: [],
    permissions: "unverified",
  };

  it("should_show_the_target_base_url_and_prod_marker", () => {
    const text = renderWhoami(report);
    expect(text).toContain("target:      prod (PROD)");
    expect(text).toContain("https://example.polyant.ai");
  });

  it("should_state_that_permissions_are_unverified", () => {
    expect(renderWhoami(report)).toMatch(/permissions:.*not verified/);
  });

  it("should_list_the_agents_with_their_auth_state", () => {
    expect(renderWhoami(report)).toContain("acme");
  });
});

describe("whoamiCommand.run", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    loadWorkspaceConfig.mockResolvedValue(undefined);
    resolveTarget.mockReturnValue(TARGET);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) =>
        url.pathname === "/health"
          ? jsonResponse(200, { status: "ok", timestamp: "t", service: "polyant" })
          : jsonResponse(200, {
              instances: [
                { slug: "closed", status: "active", authEnabled: true },
                { slug: "open", status: "active", authEnabled: false },
              ],
            }),
      ),
    );
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    loadWorkspaceConfig.mockReset();
    resolveTarget.mockReset();
  });

  it("should_print_the_text_report_on_stdout_by_default", async () => {
    await whoamiCommand.run([]);
    expect(out.join("")).toContain("target:      prod (PROD)");
    expect(out.join("")).toContain("closed");
  });

  it("should_emit_one_parsable_json_object_when_json_is_asked", async () => {
    await whoamiCommand.run(["--json"]);
    const parsed = JSON.parse(out.join("")) as { target: string; openAgents: string[] };
    expect(parsed.target).toBe("prod");
    expect(parsed.openAgents).toEqual(["open"]);
  });

  // An agent with authEnabled false has open runtime routes. Naming it is the
  // whole point of the command, so it must reach stderr in both output modes.
  it("should_name_every_agent_with_auth_disabled_on_stderr", async () => {
    await whoamiCommand.run([]);
    expect(err.join("")).toContain('agent "open" has authEnabled=false');
    expect(err.join("")).not.toContain('"closed"');
  });

  // The warning must not be a casualty of choosing machine-readable output: an
  // agent driving the CLI is exactly who needs to be told the routes are open.
  it("should_still_name_agents_with_auth_disabled_on_stderr_when_json_is_asked", async () => {
    await whoamiCommand.run(["--json"]);
    expect(err.join("")).toContain('agent "open" has authEnabled=false');
  });

  it("should_print_usage_and_send_no_request_when_help_is_asked", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await whoamiCommand.run(["--help"]);
    expect(out.join("")).toContain("Usage: polyant-cli whoami");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should_use_the_global_json_option_without_forwarding_it_to_the_local_parser", async () => {
    await whoamiCommand.run([], {
      path: ["whoami"],
      global: { json: true, yes: false, dryRun: false },
    });

    expect(JSON.parse(out.join(""))).toMatchObject({ target: "prod" });
  });
});
