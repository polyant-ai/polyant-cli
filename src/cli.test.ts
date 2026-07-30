// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { COMMANDS, renderHelp, renderVersion, run } from "./cli.js";
import { ConfigError, ExitCode, RemoteError } from "./exit.js";

const apiMocks = vi.hoisted(() => ({
  request: vi.fn(),
  requestStream: vi.fn(),
  loadWorkspaceConfig: vi.fn(),
  resolveTarget: vi.fn(),
}));

vi.mock("./api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/client.js")>()),
  request: apiMocks.request,
  requestStream: apiMocks.requestStream,
}));
vi.mock("./config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./config.js")>()),
  loadWorkspaceConfig: apiMocks.loadWorkspaceConfig,
  resolveTarget: apiMocks.resolveTarget,
}));

const BUILT_IN = Object.keys(COMMANDS);

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  apiMocks.request.mockResolvedValue({ status: 200, raw: "{}", body: {} });
  apiMocks.loadWorkspaceConfig.mockResolvedValue(undefined);
  apiMocks.resolveTarget.mockReturnValue({
    name: "dev",
    baseUrl: "http://localhost:4000",
    key: "pk_uuid_secret",
    prod: false,
  });
  // The cast is needed because `write` is overloaded; without it the one-arg
  // implementation does not match the declared type under `strict`.
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
  apiMocks.request.mockReset();
  apiMocks.loadWorkspaceConfig.mockReset();
  apiMocks.resolveTarget.mockReset();
  for (const name of Object.keys(COMMANDS)) {
    if (!BUILT_IN.includes(name)) delete COMMANDS[name];
  }
});

describe("run", () => {
  it("should_print_help_and_exit_0_when_no_command_is_given", async () => {
    expect(await run([])).toBe(ExitCode.Ok);
    expect(out.join("")).toContain("Usage: polyant-cli <command>");
  });

  it("should_exit_2_when_the_command_is_unknown", async () => {
    expect(await run(["nope"])).toBe(ExitCode.Config);
    expect(err.join("")).toContain('Unknown command "nope"');
  });

  it("should_exit_2_when_a_prototype_property_is_used_as_a_command", async () => {
    expect(await run(["constructor"])).toBe(ExitCode.Config);
    expect(err.join("")).toContain('Unknown command "constructor"');
  });

  it("should_exit_0_and_forward_argv_when_the_command_succeeds", async () => {
    const seen: string[][] = [];
    COMMANDS.demo = {
      summary: "demo",
      usage: "usage: demo",
      run: async (argv) => {
        seen.push(argv);
      },
    };
    expect(await run(["demo", "a", "--b"])).toBe(ExitCode.Ok);
    expect(seen).toEqual([["a", "--b"]]);
  });

  it("should_return_the_carried_code_when_a_cli_error_is_thrown", async () => {
    COMMANDS.boom = {
      summary: "boom",
      usage: "usage: boom",
      run: async () => {
        throw new RemoteError("upstream is down", ExitCode.Remote, 503);
      },
    };
    expect(await run(["boom"])).toBe(ExitCode.Remote);
    expect(err.join("")).toContain("upstream is down");
  });

  it("should_exit_2_and_label_the_failure_when_an_unexpected_error_escapes", async () => {
    COMMANDS.bug = {
      summary: "bug",
      usage: "usage: bug",
      run: async () => {
        throw new TypeError("cannot read properties of undefined");
      },
    };
    expect(await run(["bug"])).toBe(ExitCode.Config);
    expect(err.join("")).toContain("Internal error:");
  });

  it("should_list_registered_commands_in_help", () => {
    COMMANDS.zeta = { summary: "last", usage: "u", run: async () => {} };
    COMMANDS.alpha = { summary: "first", usage: "u", run: async () => {} };
    const help = renderHelp();
    expect(help.indexOf("alpha")).toBeLessThan(help.indexOf("zeta"));
    expect(help).toContain("first");
  });

  it("should_list_resource_families_in_root_help", () => {
    const help = renderHelp();
    expect(help).toContain("agent");
    expect(help).toContain("api");
    expect(help).toContain("\n  config");
    expect(help).toContain("whoami");
  });

  it("should_show_only_agent_actions_in_agent_help", async () => {
    expect(await run(["agent", "--help"])).toBe(ExitCode.Ok);
    expect(out.join("")).toContain("Usage: polyant-cli agent <action>");
    expect(out.join("")).toContain("list");
    expect(out.join("")).not.toContain("whoami");
    expect(out.join("")).not.toContain("raw passthrough");
  });

  it("should_show_agent_help_when_help_is_its_action", async () => {
    expect(await run(["agent", "help"])).toBe(ExitCode.Ok);
    expect(out.join("")).toContain("Usage: polyant-cli agent <action>");
  });

  it("should_exit_2_for_an_unknown_agent_action_even_when_help_follows", async () => {
    expect(await run(["agent", "nonexistent", "--help"])).toBe(ExitCode.Config);
    expect(err.join("")).toContain('Unknown command "agent nonexistent"');
  });

  it("should_exit_2_when_an_agent_write_runs_without_a_selected_workspace", async () => {
    expect(await run(["agent", "create", "acme", "--name", "Acme", "--yes"])).toBe(ExitCode.Config);
    expect(err.join("")).toContain("Missing required scope component");
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("should_recap_but_not_dispatch_an_api_mutation_on_a_dry_run", async () => {
    expect(await run(["api", "PATCH", "/api/instances/acme", "--dry-run"])).toBe(ExitCode.Ok);
    expect(err.join("")).toContain("dry-run");
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("should_reject_dry_run_on_a_command_that_does_not_own_it", async () => {
    expect(await run(["whoami", "--dry-run"])).toBe(ExitCode.Config);
    expect(err.join("")).toContain("--dry-run is not supported");
    expect(apiMocks.request).not.toHaveBeenCalled();
  });

  it("should_dispatch_api_and_whoami_with_their_global_context", async () => {
    const apiRun = vi.spyOn(COMMANDS.api, "run").mockResolvedValue(undefined);
    const whoamiRun = vi.spyOn(COMMANDS.whoami, "run").mockResolvedValue(undefined);

    expect(await run(["api", "GET", "/health", "--target", "prod"])).toBe(ExitCode.Ok);
    expect(apiRun).toHaveBeenCalledWith(
      ["GET", "/health"],
      expect.objectContaining({ path: ["api"], global: expect.objectContaining({ target: "prod" }) }),
    );

    expect(await run(["whoami", "--json"])).toBe(ExitCode.Ok);
    expect(whoamiRun).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ path: ["whoami"], global: expect.objectContaining({ json: true }) }),
    );
  });
});

describe("--version", () => {
  it("reports the version from the package manifest, not a duplicated constant", async () => {
    const { version, name } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string; name: string };

    expect(await run(["--version"])).toBe(ExitCode.Ok);
    expect(out.join("")).toBe(`${name} ${version} (node ${process.version})\n`);
  });

  it("accepts -v and the bare `version` command too", async () => {
    for (const argv of [["-v"], ["version"]]) {
      out.length = 0;
      expect(await run(argv)).toBe(ExitCode.Ok);
      expect(out.join("")).toContain(renderVersion());
    }
  });

  // Root position only: `agent --version` is not a question about the agent, and
  // must not be swallowed as one.
  it("does not answer a version flag after a command", async () => {
    expect(await run(["agent", "--version"])).toBe(ExitCode.Config);
    expect(out.join("")).not.toContain("node ");
  });

  it("offers it in the root help", () => {
    expect(renderHelp()).toContain("--version");
  });

  it("sends the version to stdout and nothing to stderr", async () => {
    await run(["--version"]);
    expect(err.join("")).toBe("");
  });
});

describe("ConfigError from a command", () => {
  it("should_exit_2_when_a_command_raises_a_config_error", async () => {
    COMMANDS.cfg = {
      summary: "cfg",
      usage: "u",
      run: async () => {
        throw new ConfigError("POLYANT_KEY is unset");
      },
    };
    expect(await run(["cfg"])).toBe(ExitCode.Config);
    expect(err.join("")).toContain("POLYANT_KEY is unset");
  });
});
