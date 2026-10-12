// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigError } from "../exit.js";

// The network and the filesystem are the two things `run()` must not touch in a
// test. Mocked before the module under test is imported, then imported with a
// top-level await so the mocks are already in place.
const request = vi.fn();
const loadWorkspaceConfig = vi.fn();
const resolveTarget = vi.fn();

vi.mock("../api/client.js", () => ({ request }));
vi.mock("../config.js", () => ({ loadWorkspaceConfig, resolveTarget }));

const { apiCommand, parseApiArgs } = await import("./api.js");

describe("parseApiArgs", () => {
  it("should_read_the_method_and_path_from_positionals", () => {
    const args = parseApiArgs(["GET", "/api/instances"]);
    expect(args.method).toBe("GET");
    expect(args.path).toBe("/api/instances");
    expect(args.query).toEqual({});
  });

  it("should_uppercase_the_method", () => {
    expect(parseApiArgs(["get", "/health"]).method).toBe("GET");
  });

  it("should_collect_repeated_query_flags", () => {
    const args = parseApiArgs(["GET", "/api/conversations", "--query", "instanceId=acme", "--query", "limit=5"]);
    expect(args.query).toEqual({ instanceId: "acme", limit: "5" });
  });

  it("should_keep_equals_signs_inside_a_query_value", () => {
    expect(parseApiArgs(["GET", "/x", "--query", "q=a=b"]).query).toEqual({ q: "a=b" });
  });

  it("should_read_the_target_and_url_flags", () => {
    const args = parseApiArgs(["GET", "/x", "--target", "prod", "--url", "http://localhost:4000"]);
    expect(args.target).toBe("prod");
    expect(args.url).toBe("http://localhost:4000");
  });

  it("should_reject_an_unsupported_method", () => {
    expect(() => parseApiArgs(["FETCH", "/x"])).toThrow(/Unsupported method "FETCH"/);
  });

  it("should_reject_a_missing_path", () => {
    expect(() => parseApiArgs(["GET"])).toThrow(ConfigError);
  });

  it("should_reject_a_missing_method", () => {
    expect(() => parseApiArgs([])).toThrow(ConfigError);
  });

  it("should_reject_an_unknown_flag_with_a_config_error", () => {
    expect(() => parseApiArgs(["GET", "/x", "--verbose"])).toThrow(ConfigError);
    expect(() => parseApiArgs(["GET", "/x", "--verbose"])).toThrow(/--verbose/);
  });

  it("should_reject_a_query_flag_without_an_equals_sign", () => {
    expect(() => parseApiArgs(["GET", "/x", "--query", "oops"])).toThrow(/k=v/);
  });
});

describe("apiCommand.run", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    loadWorkspaceConfig.mockResolvedValue(undefined);
    resolveTarget.mockReturnValue({
      name: "dev",
      baseUrl: "http://localhost:4000",
      key: "pk_uuid_secret",
      prod: false,
    });
    request.mockResolvedValue({ status: 200, raw: '{"ok":true}', body: { ok: true } });
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  function context(global: Record<string, unknown> = {}) {
    return { path: ["api"], global: { json: false, yes: false, dryRun: false, ...global } } as never;
  }

  /** A caller who has already accepted the recap. */
  function approved() {
    return context({ yes: true });
  }

  function prodTarget(): void {
    resolveTarget.mockReturnValue({
      name: "live",
      baseUrl: "https://example.polyant.ai",
      key: "pk_uuid_secret",
      prod: true,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
    request.mockReset();
    loadWorkspaceConfig.mockReset();
    resolveTarget.mockReset();
  });

  it("should_print_the_body_verbatim_and_stay_silent_on_stderr_when_the_method_is_get", async () => {
    await apiCommand.run(["GET", "/api/instances"]);
    expect(out.join("")).toBe('{"ok":true}\n');
    expect(err.join("")).toBe("");
  });

  it("should_recap_a_mutation_on_stderr_and_send_it_once_confirmed", async () => {
    await apiCommand.run(["PATCH", "/api/instances/acme/tools"], approved());

    const recap = err.join("");
    expect(recap).toContain("PATCH /api/instances/acme/tools");
    expect(recap).toContain("target: dev");
    expect(recap).toContain("Send PATCH to http://localhost:4000/api/instances/acme/tools.");
    expect(recap).toContain("No request body.");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("should_refuse_a_mutation_that_is_neither_confirmed_nor_approved", async () => {
    await expect(apiCommand.run(["PATCH", "/api/instances/acme/tools"], context()))
      .rejects.toThrow(/--yes is required/);
    expect(request).not.toHaveBeenCalled();
  });

  it("should_require_yes_against_a_production_target", async () => {
    prodTarget();

    await expect(apiCommand.run(["PATCH", "/api/instances/acme"], context())).rejects.toThrow(/targets production/);
    expect(request).not.toHaveBeenCalled();
  });

  it("should_mark_a_production_target_in_the_recap", async () => {
    prodTarget();

    await apiCommand.run(["PATCH", "/api/instances/acme"], approved());

    expect(err.join("")).toContain("target: live (PROD)");
  });

  it("should_require_a_matching_confirm_before_a_delete", async () => {
    await expect(apiCommand.run(["DELETE", "/api/instances/acme"], approved()))
      .rejects.toThrow(/--confirm \/api\/instances\/acme is required/);
    expect(request).not.toHaveBeenCalled();
  });

  it("should_send_nothing_on_a_dry_run", async () => {
    await apiCommand.run(["PATCH", "/api/instances/acme"], context({ dryRun: true }));

    expect(request).not.toHaveBeenCalled();
    expect(err.join("")).toContain("dry-run");
    expect(out.join("")).toBe("");
  });

  it("should_print_a_plain_text_body_unchanged", async () => {
    request.mockResolvedValue({ status: 200, raw: "plain", body: "plain" });
    await apiCommand.run(["GET", "/health"]);
    expect(out.join("")).toBe("plain\n");
  });

  it("should_print_nothing_when_the_response_has_no_body", async () => {
    request.mockResolvedValue({ status: 204, raw: "", body: null });
    await apiCommand.run(["DELETE", "/api/instances/acme", "--confirm", "/api/instances/acme"], approved());
    expect(out.join("")).toBe("");
  });

  it("should_print_usage_and_send_no_request_when_help_is_asked", async () => {
    await apiCommand.run(["--help"]);
    expect(out.join("")).toContain("Usage: polyant-cli api");
    expect(request).not.toHaveBeenCalled();
  });

  it("should_use_the_global_target_without_forwarding_it_to_the_local_parser", async () => {
    await apiCommand.run(["GET", "/health"], {
      path: ["api"],
      global: { target: "prod", json: false, yes: false, dryRun: false },
    });

    expect(resolveTarget).toHaveBeenCalledWith(expect.objectContaining({ target: "prod" }));
  });

  it("should_use_the_context_target_and_keep_a_command_local_url_override", async () => {
    const config = {
      default: "dev",
      targets: {
        dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV" },
        prod: { baseUrl: "https://example.polyant.ai", keyEnv: "POLYANT_KEY_PROD", prod: true },
      },
      contexts: {
        production: { target: "prod", org: "polyant", workspace: "platform" },
      },
    };
    loadWorkspaceConfig.mockResolvedValue(config);
    resolveTarget.mockImplementation((options) =>
      options.target === "prod"
        ? { name: "prod", baseUrl: options.url ?? "https://example.polyant.ai", key: "pk_prod", prod: true }
        : { name: "dev", baseUrl: "http://localhost:4000", key: "pk_dev", prod: false },
    );

    await apiCommand.run(["GET", "/health", "--url", "http://localhost:4400"], {
      path: ["api"],
      global: { context: "production", json: false, yes: false, dryRun: false },
    });

    expect(resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ config, target: "prod", url: "http://localhost:4400" }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ name: "prod", baseUrl: "http://localhost:4400", key: "pk_prod", prod: true }),
      expect.anything(),
    );
  });
});
