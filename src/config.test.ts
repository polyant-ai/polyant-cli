// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, it, expect } from "vitest";
import {
  loadWorkspaceConfig,
  parseWorkspaceConfig,
  resolveTarget,
  type WorkspaceConfig,
} from "./config.js";
import { ConfigError } from "./exit.js";

const YAML = `
default: staging

targets:
  staging:
    baseUrl: https://staging.example.polyant.ai
    keyEnv: POLYANT_KEY_STAGING
  prod:
    baseUrl: https://example.polyant.ai/
    keyEnv: POLYANT_KEY_PROD
    prod: true
`;

describe("parseWorkspaceConfig", () => {
  it("should_read_targets_and_default_when_the_document_is_valid", () => {
    const config = parseWorkspaceConfig(YAML);
    expect(config.default).toBe("staging");
    expect(Object.keys(config.targets).sort()).toEqual(["prod", "staging"]);
    expect(config.targets.staging.keyEnv).toBe("POLYANT_KEY_STAGING");
    expect(config.targets.prod.prod).toBe(true);
  });

  it("should_read_named_contexts_and_the_default_context", () => {
    const config = parseWorkspaceConfig(
      `targets:\n  staging:\n    baseUrl: https://staging.example.polyant.ai\n    keyEnv: POLYANT_KEY_STAGING\ncontexts:\n  engineering:\n    target: staging\n    org: polyant\n    workspace: platform\ndefaultContext: engineering\n`,
    );

    expect(config.contexts).toEqual({
      engineering: { target: "staging", org: "polyant", workspace: "platform" },
    });
    expect(config.defaultContext).toBe("engineering");
  });

  it("should_strip_trailing_slashes_when_the_base_url_has_them", () => {
    expect(parseWorkspaceConfig(YAML).targets.prod.baseUrl).toBe("https://example.polyant.ai");
  });

  it("should_reject_the_document_when_the_yaml_is_not_a_mapping", () => {
    expect(() => parseWorkspaceConfig("just a string\n")).toThrow(/expected a mapping at the top level/);
  });

  it("should_refuse_a_literal_key_and_point_at_key_env", () => {
    const bad = `targets:\n  dev:\n    baseUrl: http://localhost:4000\n    key: pk_abc_def\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(ConfigError);
    expect(() => parseWorkspaceConfig(bad)).toThrow(/keyEnv/);
  });

  it("should_reject_a_base_url_without_a_scheme", () => {
    const bad = `targets:\n  dev:\n    baseUrl: localhost:4000\n    keyEnv: K\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(/baseUrl/);
  });

  it("should_reject_a_missing_key_env", () => {
    const bad = `targets:\n  dev:\n    baseUrl: http://localhost:4000\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(/keyEnv/);
  });

  it("should_reject_an_empty_targets_mapping", () => {
    expect(() => parseWorkspaceConfig("targets: {}\n")).toThrow(/non-empty "targets"/);
  });

  it("should_reject_a_default_that_names_no_declared_target", () => {
    const bad = `default: ghost\ntargets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: K\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(/must name one of/);
  });

  it("should_reject_a_context_that_references_an_unknown_target", () => {
    const bad = `targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: K\ncontexts:\n  local:\n    target: ghost\n    org: polyant\n    workspace: platform\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(/context "local" references unknown target "ghost"/);
  });

  it("should_reject_a_context_with_a_non_string_org", () => {
    const bad = `targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: K\ncontexts:\n  local:\n    target: dev\n    org: 1\n    workspace: platform\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(/context "local" needs a non-empty string "org"/);
  });

  it("should_reject_a_context_with_an_empty_workspace", () => {
    const bad = `targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: K\ncontexts:\n  local:\n    target: dev\n    org: polyant\n    workspace: ""\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(/context "local" needs a non-empty string "workspace"/);
  });

  it("should_reject_contexts_when_they_are_not_a_mapping", () => {
    const bad = `targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: K\ncontexts: local\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(/"contexts" must be a mapping/);
  });

  it("should_reject_a_context_entry_that_is_not_a_mapping", () => {
    const bad = `targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: K\ncontexts:\n  local: dev\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(/context "local" must be a mapping/);
  });

  it("should_refuse_a_literal_key_in_a_context_without_echoing_it", () => {
    const bad = `targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: K\ncontexts:\n  local:\n    target: dev\n    org: polyant\n    workspace: platform\n    key: pk_context_secret\n`;

    expect(() => parseWorkspaceConfig(bad)).toThrow(/context "local" declares "key"/);
    expect(() => parseWorkspaceConfig(bad)).toThrow(/keyEnv/);
    expect(() => parseWorkspaceConfig(bad)).not.toThrow(/pk_context_secret/);
  });

  it("should_reject_a_default_context_that_is_not_declared", () => {
    const bad = `targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: K\ndefaultContext: ghost\ncontexts:\n  local:\n    target: dev\n    org: polyant\n    workspace: platform\n`;
    expect(() => parseWorkspaceConfig(bad)).toThrow(/"defaultContext" must name a declared context/);
  });

  it("should_reject_invalid_yaml", () => {
    expect(() => parseWorkspaceConfig("targets:\n  - [oops\n")).toThrow(ConfigError);
  });
});

describe("resolveTarget", () => {
  const config: WorkspaceConfig = parseWorkspaceConfig(YAML);

  it("should_use_the_default_target_when_nothing_overrides_it", () => {
    const t = resolveTarget({ config, env: { POLYANT_KEY_STAGING: "pk_1_a" } });
    expect(t.name).toBe("staging");
    expect(t.baseUrl).toBe("https://staging.example.polyant.ai");
    expect(t.key).toBe("pk_1_a");
    expect(t.prod).toBe(false);
  });

  it("should_prefer_the_flag_when_both_the_env_var_and_the_file_name_a_target", () => {
    const env = { POLYANT_TARGET: "staging", POLYANT_KEY_PROD: "pk_2_b" };
    expect(resolveTarget({ config, env, target: "prod" }).name).toBe("prod");
  });

  it("should_use_the_env_target_when_no_flag_is_given", () => {
    const env = { POLYANT_TARGET: "prod", POLYANT_KEY_PROD: "pk_2_b" };
    expect(resolveTarget({ config, env }).name).toBe("prod");
  });

  it("should_carry_the_prod_flag_when_the_target_declares_it", () => {
    const t = resolveTarget({ config, env: { POLYANT_KEY_PROD: "pk_2_b" }, target: "prod" });
    expect(t.prod).toBe(true);
  });

  it("should_override_the_base_url_when_the_url_flag_is_given", () => {
    const t = resolveTarget({
      config,
      env: { POLYANT_KEY_STAGING: "pk_1_a" },
      url: "http://localhost:4000/",
    });
    expect(t.baseUrl).toBe("http://localhost:4000");
  });

  // A stray POLYANT_URL export must not retarget a named target: it would keep
  // that target's key and prod flag while pointing at another host.
  it("should_ignore_polyant_url_when_a_config_file_declares_the_target", () => {
    const t = resolveTarget({
      config,
      env: { POLYANT_KEY_STAGING: "pk_1_a", POLYANT_URL: "http://elsewhere.invalid" },
    });
    expect(t.baseUrl).toBe("https://staging.example.polyant.ai");
  });

  it("should_reject_a_url_flag_without_a_scheme", () => {
    expect(() =>
      resolveTarget({ config, env: { POLYANT_KEY_STAGING: "pk_1_a" }, url: "localhost:4000" }),
    ).toThrow(/--url must be a URL starting with http/);
  });

  it("should_reject_an_env_url_without_a_scheme_when_there_is_no_config_file", () => {
    expect(() =>
      resolveTarget({ env: { POLYANT_URL: "localhost:4000", POLYANT_KEY: "pk_3_c" } }),
    ).toThrow(/POLYANT_URL must be a URL starting with http/);
  });

  it("should_fail_when_the_named_target_is_not_declared", () => {
    expect(() => resolveTarget({ config, env: {}, target: "ghost" })).toThrow(/Unknown target "ghost"/);
  });

  it("should_name_the_missing_env_var_when_the_key_is_unset", () => {
    expect(() => resolveTarget({ config, env: {} })).toThrow(/POLYANT_KEY_STAGING/);
  });

  it("should_treat_an_empty_env_var_as_unset_when_the_key_is_declared", () => {
    expect(() => resolveTarget({ config, env: { POLYANT_KEY_STAGING: "" } })).toThrow(
      /POLYANT_KEY_STAGING/,
    );
  });

  it("should_require_an_explicit_target_when_there_is_no_default_and_several_targets", () => {
    const noDefault = parseWorkspaceConfig(
      `targets:\n  a:\n    baseUrl: http://a\n    keyEnv: A\n  b:\n    baseUrl: http://b\n    keyEnv: B\n`,
    );
    expect(() => resolveTarget({ config: noDefault, env: { A: "x", B: "y" } })).toThrow(/--target/);
  });

  it("should_use_the_only_target_when_there_is_no_default_and_exactly_one", () => {
    const single = parseWorkspaceConfig(`targets:\n  only:\n    baseUrl: http://a\n    keyEnv: A\n`);
    expect(resolveTarget({ config: single, env: { A: "x" } }).name).toBe("only");
  });

  it("should_fall_back_to_env_only_when_there_is_no_config_file", () => {
    const t = resolveTarget({
      env: { POLYANT_URL: "http://localhost:4000", POLYANT_KEY: "pk_3_c" },
    });
    expect(t).toEqual({ name: "env", baseUrl: "http://localhost:4000", key: "pk_3_c", prod: false });
  });

  it("should_explain_both_options_when_no_config_and_no_env_url", () => {
    expect(() => resolveTarget({ env: { POLYANT_KEY: "pk_3_c" } })).toThrow(/POLYANT_URL/);
  });

  it("should_explain_both_options_when_no_config_and_no_env_key", () => {
    expect(() => resolveTarget({ env: { POLYANT_URL: "http://localhost:4000" } })).toThrow(/POLYANT_KEY/);
  });

  it("should_reject_an_explicit_target_when_there_is_no_config_file", () => {
    expect(() =>
      resolveTarget({
        env: { POLYANT_URL: "http://localhost:4000", POLYANT_KEY: "pk_3_c" },
        target: "prod",
      }),
    ).toThrow(/needs a polyant\.yaml declaring that target/);
  });

  it("should_ignore_the_env_target_when_there_is_no_config_file", () => {
    const t = resolveTarget({
      env: {
        POLYANT_TARGET: "prod",
        POLYANT_URL: "http://localhost:4000",
        POLYANT_KEY: "pk_3_c",
      },
    });
    expect(t.name).toBe("env");
  });
});

describe("loadWorkspaceConfig", () => {
  it("should_return_undefined_when_the_file_is_absent", async () => {
    expect(await loadWorkspaceConfig("no-such-polyant-config.yaml")).toBeUndefined();
  });

  it("should_raise_a_config_error_when_the_path_exists_but_is_unreadable", async () => {
    // A directory resolves as a path but not as a file: EISDIR, not ENOENT.
    // Without the ENOENT check this would be reported as "no workspace".
    await expect(loadWorkspaceConfig("src")).rejects.toThrow(/Cannot read src/);
  });
});
