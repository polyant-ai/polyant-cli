// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { Command } from "../command.js";
import { parseInvocation } from "../runtime/global-options.js";
import { createConfigCommand, type ConfigCommandDependencies } from "./config.js";

/**
 * Runs argv the way the binary does, global parser first. `--url`, `--target`,
 * `--org` and `--workspace` are lifted out of argv before a command sees it, so
 * a test that hands them to the command directly passes where a user fails.
 */
async function invoke(command: Command, argv: string[]): Promise<void> {
  const { path, args, global } = parseInvocation(["config", ...argv], { config: command });
  let node: Command | undefined = command;
  for (const segment of path.slice(1)) node = node?.children?.[segment];
  if (node?.run === undefined) throw new Error(`No such action: ${path.join(" ")}`);
  await node.run(args, { path, global });
}

function capture(overrides: Partial<ConfigCommandDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeFile = vi.fn(async () => {});
  const rename = vi.fn(async () => {});
  const prompt = vi.fn(async () => {
    throw new Error("a complete init must not prompt");
  });
  const deps: ConfigCommandDependencies = {
    configPath: "/workspace/polyant.yaml",
    env: {},
    fs: {
      readFile: vi.fn(async () => {
        const error = Object.assign(new Error("not found"), { code: "ENOENT" });
        throw error;
      }),
      writeFile,
      rename,
    },
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      input: { isTTY: true, readLine: vi.fn(async () => "y") },
    },
    prompt,
    temporaryName: () => "/workspace/.polyant.yaml.test.tmp",
    ...overrides,
  };
  return { command: createConfigCommand(deps), stdout, stderr, writeFile, rename, prompt };
}

describe("config init", () => {
  it("shows the safe YAML diff and atomically writes complete non-secret flags without prompting", async () => {
    const { command, stderr, writeFile, rename, prompt } = capture();

    await invoke(command, ["init", "--url", "http://localhost:4000", "--key-env", "POLYANT_KEY_DEV", "--target", "dev", "--yes"]);

    expect(prompt).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("+++ /workspace/polyant.yaml");
    expect(stderr.join("")).toContain("+    keyEnv: POLYANT_KEY_DEV");
    expect(writeFile).toHaveBeenCalledWith(
      "/workspace/.polyant.yaml.test.tmp",
      expect.stringContaining("keyEnv: POLYANT_KEY_DEV"),
      "utf8",
    );
    expect(rename).toHaveBeenCalledWith("/workspace/.polyant.yaml.test.tmp", "/workspace/polyant.yaml");
  });

  it("refuses to overwrite an existing file without --force", async () => {
    const writeFile = vi.fn(async () => {});
    const { command } = capture({
      fs: {
        readFile: vi.fn(async () => "targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n"),
        writeFile,
        rename: vi.fn(async () => {}),
      },
    });

    await expect(
      invoke(command, ["init", "--url", "http://localhost:4000", "--key-env", "POLYANT_KEY_DEV", "--target", "dev", "--yes"]),
    ).rejects.toThrow(/already exists; pass --force/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("prints the diff before beginning the atomic write", async () => {
    const events: string[] = [];
    const stderr: string[] = [];
    const command = createConfigCommand({
      configPath: "/workspace/polyant.yaml",
      env: {},
      fs: {
        readFile: vi.fn(async () => {
          const error = Object.assign(new Error("not found"), { code: "ENOENT" });
          throw error;
        }),
        writeFile: vi.fn(async () => {
          events.push(stderr.join("").includes("+++ /workspace/polyant.yaml") ? "diff-first" : "write-first");
        }),
        rename: vi.fn(async () => {}),
      },
      io: {
        stdout: () => {},
        stderr: (text) => stderr.push(text),
        input: { isTTY: true, readLine: vi.fn(async () => "y") },
      },
      prompt: vi.fn(async () => ""),
      temporaryName: () => "/workspace/.polyant.yaml.test.tmp",
    });

    await invoke(command, ["init", "--url", "http://localhost:4000", "--key-env", "POLYANT_KEY_DEV", "--target", "dev", "--yes"]);

    expect(events).toEqual(["diff-first"]);
  });
});

describe("config write reporting", () => {
  const INIT = ["init", "--url", "http://localhost:4000", "--key-env", "POLYANT_KEY_DEV", "--target", "dev"];

  // Every other write in the CLI reports what it did. Silence after a confirmed
  // change cannot be told apart from a change that never happened.
  it("confirms the written path after a change is accepted", async () => {
    const { command, stdout, rename } = capture();

    await invoke(command, [...INIT, "--yes"]);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(stdout.join("")).toContain("Wrote /workspace/polyant.yaml.");
  });

  it("stays silent about writing on a dry run", async () => {
    const { command, stdout, rename } = capture();

    await invoke(command, [...INIT, "--dry-run"]);

    expect(rename).not.toHaveBeenCalled();
    expect(stdout.join("")).not.toContain("Wrote");
  });
});

describe("config validate", () => {
  it("validates the local YAML without requiring a management key", async () => {
    const { command, stdout } = capture({
      fs: {
        readFile: vi.fn(async () => "targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n"),
        writeFile: vi.fn(async () => {}),
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["validate"]);

    expect(stdout.join("")).toContain("polyant.yaml is valid");
  });
});

describe("config show", () => {
  it("prints the versioned YAML and never reads a management key", async () => {
    const yaml = "default: dev\ntargets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n";
    const { command, stdout } = capture({
      fs: {
        readFile: vi.fn(async () => yaml),
        writeFile: vi.fn(async () => {}),
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["show"]);

    expect(stdout.join("")).toBe(yaml);
  });

  it("refuses an unsafe literal key without writing the value to stdout", async () => {
    const secret = "pk_never_display_this";
    const { command, stdout } = capture({
      fs: {
        readFile: vi.fn(async () => `targets:\n  dev:\n    baseUrl: http://localhost:4000\n    key: ${secret}\n`),
        writeFile: vi.fn(async () => {}),
        rename: vi.fn(async () => {}),
      },
    });

    await expect(command.run?.(["show"])).rejects.toThrow(/keyEnv/);
    expect(stdout.join("")).not.toContain(secret);
  });
});

describe("config doctor", () => {
  it("suggests export when a key environment variable is unset", async () => {
    const { command, stdout } = capture({
      env: {},
      fs: {
        readFile: vi.fn(async () => "targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n"),
        writeFile: vi.fn(async () => {}),
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["doctor"], { path: ["config", "doctor"], global: { json: false, yes: false, dryRun: false } });

    // `VAR=value` without `export` is the usual cause, and invisible otherwise.
    expect(stdout.join("")).toContain("POLYANT_KEY_DEV is unset — is it exported?");
    expect(stdout.join("")).not.toContain("secret");
  });

  it("names an unset key environment variable without leaking its value", async () => {
    const secret = "pk_do_not_print_me";
    const { command, stdout } = capture({
      env: { POLYANT_KEY_DEV: secret, POLYANT_KEY_PROD: "" },
      fs: {
        readFile: vi.fn(async () => "targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n  prod:\n    baseUrl: https://example.polyant.ai\n    keyEnv: POLYANT_KEY_PROD\n"),
        writeFile: vi.fn(async () => {}),
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["doctor"]);

    expect(stdout.join("")).toContain("POLYANT_KEY_PROD is unset");
    expect(stdout.join("")).not.toContain(secret);
  });
});

describe("config target add", () => {
  it("plans then atomically adds a non-secret target without reading its key", async () => {
    const writeFile = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const { command, stderr } = capture({
      fs: {
        readFile: vi.fn(async () => "default: dev\ntargets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n"),
        writeFile,
        rename,
      },
    });

    await invoke(command, ["target", "add", "preview", "--url", "https://preview.example.polyant.ai", "--key-env", "POLYANT_KEY_PREVIEW", "--yes"]);

    expect(stderr.join("")).toContain("Add target preview");
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("POLYANT_KEY_PREVIEW"), "utf8");
    expect(rename).toHaveBeenCalled();
  });
});

describe("config target edit", () => {
  it("updates a declared target through the local mutation confirmation", async () => {
    const writeFile = vi.fn(async () => {});
    const { command, stderr } = capture({
      fs: {
        readFile: vi.fn(async () => "default: dev\ntargets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n"),
        writeFile,
        rename: vi.fn(async () => {}),
      },
    });

    await invoke(command, ["target", "edit", "dev", "--url", "https://dev.example.polyant.ai", "--prod", "--yes"]);

    expect(stderr.join("")).toContain("Edit target dev");
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("prod: true"), "utf8");
  });
});

describe("config target default", () => {
  it("changes the selected target through a confirmed local write", async () => {
    const writeFile = vi.fn(async () => {});
    const { command, stderr } = capture({
      fs: {
        readFile: vi.fn(async () => "default: dev\ntargets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n  prod:\n    baseUrl: https://example.polyant.ai\n    keyEnv: POLYANT_KEY_PROD\n"),
        writeFile,
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["target", "default", "prod"], {
      path: ["config", "target", "default"],
      global: { json: false, yes: true, dryRun: false },
    });

    expect(stderr.join("")).toContain("Set default target to prod");
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^default: prod/m), "utf8");
  });
});

describe("config target remove", () => {
  it("removes a non-default target after a local confirmation", async () => {
    const writeFile = vi.fn(async () => {});
    const { command, stderr } = capture({
      fs: {
        readFile: vi.fn(async () => "default: dev\ntargets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n  preview:\n    baseUrl: https://preview.example.polyant.ai\n    keyEnv: POLYANT_KEY_PREVIEW\n"),
        writeFile,
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["target", "remove", "preview"], {
      path: ["config", "target", "remove"],
      global: { json: false, yes: true, dryRun: false },
    });

    expect(stderr.join("")).toContain("Remove target preview");
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.not.stringContaining("preview.example.polyant.ai"), "utf8");
  });
});

describe("config context add", () => {
  it("adds a non-secret target/org/workspace shortcut through the shared confirmation", async () => {
    const writeFile = vi.fn(async () => {});
    const { command, stderr } = capture({
      fs: {
        readFile: vi.fn(async () => "default: dev\ntargets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\n"),
        writeFile,
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["context", "add", "engineering"], {
      path: ["config", "context", "add"],
      global: { target: "dev", org: "polyant", workspace: "platform", json: false, yes: true, dryRun: false },
    });

    expect(stderr.join("")).toContain("Add context engineering");
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("workspace: platform"), "utf8");
  });
});

describe("config context edit", () => {
  it("updates only the explicitly supplied scope fields", async () => {
    const writeFile = vi.fn(async () => {});
    const { command, stderr } = capture({
      fs: {
        readFile: vi.fn(async () => "targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\ncontexts:\n  engineering:\n    target: dev\n    org: polyant\n    workspace: platform\n"),
        writeFile,
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["context", "edit", "engineering"], {
      path: ["config", "context", "edit"],
      global: { workspace: "cli", json: false, yes: true, dryRun: false },
    });

    expect(stderr.join("")).toContain("Edit context engineering");
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("workspace: cli"), "utf8");
  });
});

describe("config context default", () => {
  it("selects a declared context with a confirmed local write", async () => {
    const writeFile = vi.fn(async () => {});
    const { command, stderr } = capture({
      fs: {
        readFile: vi.fn(async () => "targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\ncontexts:\n  engineering:\n    target: dev\n    org: polyant\n    workspace: platform\n"),
        writeFile,
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["context", "default", "engineering"], {
      path: ["config", "context", "default"],
      global: { json: false, yes: true, dryRun: false },
    });

    expect(stderr.join("")).toContain("Set default context to engineering");
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^defaultContext: engineering/m), "utf8");
  });
});

describe("config context remove", () => {
  it("removes a non-default context through a confirmed atomic write", async () => {
    const writeFile = vi.fn(async () => {});
    const { command, stderr } = capture({
      fs: {
        readFile: vi.fn(async () => "targets:\n  dev:\n    baseUrl: http://localhost:4000\n    keyEnv: POLYANT_KEY_DEV\ncontexts:\n  engineering:\n    target: dev\n    org: polyant\n    workspace: platform\n"),
        writeFile,
        rename: vi.fn(async () => {}),
      },
    });

    await command.run?.(["context", "remove", "engineering"], {
      path: ["config", "context", "remove"],
      global: { json: false, yes: true, dryRun: false },
    });

    expect(stderr.join("")).toContain("Remove context engineering");
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.not.stringContaining("engineering:"), "utf8");
  });
});
