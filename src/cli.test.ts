// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { COMMANDS, renderHelp, run } from "./cli.js";
import { ConfigError, ExitCode, RemoteError } from "./exit.js";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
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
  for (const name of Object.keys(COMMANDS)) delete COMMANDS[name];
});

describe("run", () => {
  it("should_print_help_and_exit_0_when_no_command_is_given", async () => {
    expect(await run([])).toBe(ExitCode.Ok);
    expect(out.join("")).toContain("Usage: polyant <command>");
  });

  it("should_exit_2_when_the_command_is_unknown", async () => {
    expect(await run(["nope"])).toBe(ExitCode.Config);
    expect(err.join("")).toContain('Unknown command "nope"');
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
