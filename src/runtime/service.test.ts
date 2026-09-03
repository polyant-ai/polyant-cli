// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import type { WorkspaceConfig } from "../config.js";
import { ConfigError } from "../exit.js";
import type { GlobalOptions } from "./global-options.js";
import { scopeFor, type ServiceDependencies } from "./service.js";

const CONFIG: WorkspaceConfig = {
  default: "dev",
  targets: { dev: { baseUrl: "http://localhost:4000", keyEnv: "POLYANT_KEY_DEV", prod: true } },
};

function deps(env: Record<string, string | undefined> = { POLYANT_KEY_DEV: "pk_dev" }): ServiceDependencies {
  return {
    request: async () => {
      throw new Error("not used");
    },
    requestStream: async () => {
      throw new Error("not used");
    },
    loadConfig: async () => CONFIG,
    env,
    io: { stdout: () => {}, stderr: () => {}, input: { isTTY: false, readLine: async () => "" } },
    readPayload: async () => "",
  };
}

function context(global: Partial<GlobalOptions>): CommandContext {
  return { global: { json: false, yes: false, dryRun: false, ...global } } as CommandContext;
}

describe("scopeFor", () => {
  it("should_apply_the_global_url_override_to_the_resolved_target", async () => {
    const scope = await scopeFor(deps(), context({ url: "https://other.example.polyant.ai" }), "read");
    expect(scope.target.baseUrl).toBe("https://other.example.polyant.ai");
  });

  it("should_keep_the_declared_key_and_prod_flag_when_the_url_is_overridden", async () => {
    const scope = await scopeFor(deps(), context({ url: "https://other.example.polyant.ai" }), "read");
    expect(scope.target).toMatchObject({ name: "dev", key: "pk_dev", prod: true });
  });

  it("should_read_the_declared_baseUrl_when_no_override_is_given", async () => {
    const scope = await scopeFor(deps(), context({}), "read");
    expect(scope.target.baseUrl).toBe("http://localhost:4000");
  });

  it("should_reject_a_url_override_that_is_not_http", async () => {
    await expect(scopeFor(deps(), context({ url: "ftp://nope.example" }), "read")).rejects.toThrow(ConfigError);
  });

  it("should_name_the_discarded_POLYANT_URL_when_the_target_key_is_missing", async () => {
    const env = { POLYANT_URL: "https://ticketing.example.polyant.ai" };
    await expect(scopeFor(deps(env), context({}), "read")).rejects.toThrow(
      /POLYANT_URL is set.*Pass --url https:\/\/ticketing\.example\.polyant\.ai/s,
    );
  });

  it("should_not_mention_POLYANT_URL_when_it_is_unset", async () => {
    await expect(scopeFor(deps({}), context({}), "read")).rejects.toThrow(/unset or empty\.$/);
  });
});
