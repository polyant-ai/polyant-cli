// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ConfigError } from "../exit.js";
import { parseInvocation, type CommandTree } from "./global-options.js";

const COMMANDS: CommandTree = {
  agent: {
    children: {
      list: {},
      get: {},
    },
  },
  api: {},
  whoami: {},
};

describe("parseInvocation", () => {
  it("should_extract_global_flags_after_a_nested_command_path", () => {
    expect(parseInvocation(["agent", "list", "--context", "dev", "--json"], COMMANDS)).toEqual({
      path: ["agent", "list"],
      args: [],
      global: {
        context: "dev",
        json: true,
        yes: false,
        dryRun: false,
      },
    });
  });

  it("should_extract_global_flags_before_a_nested_command_path", () => {
    expect(parseInvocation(["--target", "prod", "agent", "list"], COMMANDS)).toEqual({
      path: ["agent", "list"],
      args: [],
      global: {
        target: "prod",
        json: false,
        yes: false,
        dryRun: false,
      },
    });
  });

  it("should_extract_the_url_override_as_a_process_wide_flag", () => {
    expect(parseInvocation(["agent", "list", "--url", "https://other.example.polyant.ai"], COMMANDS)).toEqual({
      path: ["agent", "list"],
      args: [],
      global: {
        url: "https://other.example.polyant.ai",
        json: false,
        yes: false,
        dryRun: false,
      },
    });
  });

  it("should_reject_a_duplicate_singleton_flag", () => {
    expect(() => parseInvocation(["agent", "list", "--target", "dev", "--target", "prod"], COMMANDS)).toThrow(
      ConfigError,
    );
  });

  it("should_reject_a_global_flag_without_its_value", () => {
    expect(() => parseInvocation(["agent", "list", "--workspace"], COMMANDS)).toThrow(/Missing value for --workspace/);
  });

  it("should_reject_empty_org_and_workspace_selectors", () => {
    expect(() => parseInvocation(["agent", "list", "--org="], COMMANDS)).toThrow(/Missing value for --org/);
    expect(() => parseInvocation(["agent", "list", "--workspace="], COMMANDS)).toThrow(
      /Missing value for --workspace/,
    );
  });

  it("should_reject_an_unknown_root", () => {
    expect(() => parseInvocation(["unknown"], COMMANDS)).toThrow(/Unknown command "unknown"/);
  });

  it("should_leave_non_global_tokens_as_command_arguments", () => {
    expect(parseInvocation(["agent", "list", "acme", "--limit", "10"], COMMANDS).args).toEqual([
      "acme",
      "--limit",
      "10",
    ]);
  });

  it("should_preserve_the_end_of_options_marker_and_the_remaining_tokens", () => {
    expect(parseInvocation(["agent", "list", "--", "--context", "dev", "--json"], COMMANDS)).toEqual({
      path: ["agent", "list"],
      args: ["--", "--context", "dev", "--json"],
      global: { json: false, yes: false, dryRun: false },
    });
  });
});
