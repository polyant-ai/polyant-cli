// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseWorkspaceConfig } from "../config.js";
import { ConfigError } from "../exit.js";
import type { GlobalOptions } from "./global-options.js";
import { resolveScope } from "./scope.js";

const CONTEXT_CONFIG = parseWorkspaceConfig(`
default: staging
defaultContext: engineering
targets:
  staging:
    baseUrl: https://staging.example.polyant.ai
    keyEnv: POLYANT_KEY_STAGING
  prod:
    baseUrl: https://example.polyant.ai
    keyEnv: POLYANT_KEY_PROD
    prod: true
contexts:
  engineering:
    target: staging
    org: polyant
    workspace: platform
  production:
    target: prod
    org: polyant
    workspace: production
`);

const KEYS = { POLYANT_KEY_STAGING: "pk_staging", POLYANT_KEY_PROD: "pk_prod" };

function global(overrides: Partial<GlobalOptions> = {}): GlobalOptions {
  return { json: false, yes: false, dryRun: false, ...overrides };
}

describe("resolveScope", () => {
  it("should_select_the_default_context_for_target_and_scope", () => {
    expect(resolveScope({ config: CONTEXT_CONFIG, env: KEYS, global: global(), required: ["workspace"] })).toEqual({
      target: {
        name: "staging",
        baseUrl: "https://staging.example.polyant.ai",
        key: "pk_staging",
        prod: false,
      },
      context: "engineering",
      org: "polyant",
      workspace: "platform",
    });
  });

  it("should_prefer_an_explicit_context_over_the_default_context", () => {
    const scope = resolveScope({
      config: CONTEXT_CONFIG,
      env: KEYS,
      global: global({ context: "production" }),
      required: ["workspace"],
    });

    expect(scope.context).toBe("production");
    expect(scope.target.name).toBe("prod");
    expect(scope.org).toBe("polyant");
    expect(scope.workspace).toBe("production");
  });

  it("should_allow_target_org_and_workspace_flags_to_override_a_context", () => {
    expect(
      resolveScope({
        config: CONTEXT_CONFIG,
        env: KEYS,
        global: global({ target: "prod", org: "other-org", workspace: "other-workspace" }),
        required: ["workspace"],
      }),
    ).toMatchObject({
      target: { name: "prod", key: "pk_prod", prod: true },
      context: "engineering",
      org: "other-org",
      workspace: "other-workspace",
    });
  });

  it("should_apply_a_url_override_without_losing_the_context_target_credentials", () => {
    expect(
      resolveScope({
        config: CONTEXT_CONFIG,
        env: KEYS,
        global: global({ context: "production" }),
        url: "http://localhost:4100/",
        required: ["target"],
      }),
    ).toMatchObject({
      target: {
        name: "prod",
        baseUrl: "http://localhost:4100",
        key: "pk_prod",
        prod: true,
      },
    });
  });

  it("should_name_the_missing_required_org_without_a_selected_context", () => {
    const config = parseWorkspaceConfig(
      `targets:\n  staging:\n    baseUrl: https://staging.example.polyant.ai\n    keyEnv: POLYANT_KEY_STAGING\n`,
    );

    expect(() => resolveScope({ config, env: KEYS, global: global(), required: ["org"] })).toThrow(ConfigError);
    expect(() => resolveScope({ config, env: KEYS, global: global(), required: ["org"] })).toThrow(
      /missing required scope component "org"/i,
    );
  });

  it("should_reject_blank_explicit_scope_values_when_they_are_required", () => {
    expect(() =>
      resolveScope({ config: CONTEXT_CONFIG, env: KEYS, global: global({ org: "" }), required: ["org"] }),
    ).toThrow(/missing required scope component "org"/i);
    expect(() =>
      resolveScope({ config: CONTEXT_CONFIG, env: KEYS, global: global({ workspace: " " }), required: ["workspace"] }),
    ).toThrow(/missing required scope component "workspace"/i);
  });

  it("should_require_org_before_workspace_when_workspace_is_required", () => {
    const env = { POLYANT_URL: "http://localhost:4000", POLYANT_KEY: "pk_env" };

    expect(() => resolveScope({ env, global: global(), required: ["workspace"] })).toThrow(
      /missing required scope component "org"/i,
    );
    expect(() => resolveScope({ env, global: global({ org: "polyant" }), required: ["workspace"] })).toThrow(
      /missing required scope component "workspace"/i,
    );
  });

  it("should_support_an_env_only_target_but_not_invent_an_org", () => {
    const env = { POLYANT_URL: "http://localhost:4000", POLYANT_KEY: "pk_env" };

    expect(resolveScope({ env, global: global(), required: ["target"] }).target).toMatchObject({
      name: "env",
      key: "pk_env",
    });
    expect(() => resolveScope({ env, global: global(), required: ["org"] })).toThrow(
      /missing required scope component "org"/i,
    );
  });
});
