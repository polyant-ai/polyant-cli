// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../exit.js";
import { confirmMutation, type ConfirmationIO, type MutationPlan } from "./confirm.js";

const PLAN: MutationPlan = {
  title: "Update agent acme",
  scope: { target: "dev", prod: false, org: "polyant", workspace: "platform" },
  changes: ["Change model from gpt-4.1-mini to gpt-5.4."],
};

function captureConfirmation(options: { stdinIsTTY?: boolean; answer?: string } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const readLine = vi.fn(async () => options.answer ?? "y");
  const io: ConfirmationIO = {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    input: { isTTY: options.stdinIsTTY ?? true, readLine },
  };
  return { io, stdout, stderr, readLine };
}

describe("confirmMutation", () => {
  it("emits the scope and change recap to stderr only", async () => {
    const { io, stdout, stderr, readLine } = captureConfirmation();

    await expect(confirmMutation(PLAN, { yes: true, dryRun: false }, io)).resolves.toEqual({ shouldWrite: true });

    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("Update agent acme");
    expect(stderr.join("")).toContain("target: dev");
    expect(stderr.join("")).toContain("org: polyant");
    expect(stderr.join("")).toContain("workspace: platform");
    expect(stderr.join("")).toContain("Change model from gpt-4.1-mini to gpt-5.4.");
    expect(readLine).not.toHaveBeenCalled();
  });

  it("returns a no-write decision for dry-run without prompting", async () => {
    const { io, readLine } = captureConfirmation();

    await expect(confirmMutation(PLAN, { yes: false, dryRun: true }, io)).resolves.toEqual({ shouldWrite: false });

    expect(readLine).not.toHaveBeenCalled();
  });

  it("requires --yes for production and non-interactive mutations", async () => {
    const production = { ...PLAN, scope: { ...PLAN.scope, prod: true } };
    const prodCapture = captureConfirmation();
    const pipeCapture = captureConfirmation({ stdinIsTTY: false });

    await expect(confirmMutation(production, { yes: false, dryRun: false }, prodCapture.io)).rejects.toThrow(ConfigError);
    await expect(confirmMutation(PLAN, { yes: false, dryRun: false }, pipeCapture.io)).rejects.toThrow(ConfigError);

    expect(prodCapture.readLine).not.toHaveBeenCalled();
    expect(pipeCapture.readLine).not.toHaveBeenCalled();
  });

  it("requires both --yes and the exact destructive confirmation", async () => {
    const destructive: MutationPlan = { ...PLAN, destructive: { confirm: "acme" } };

    await expect(confirmMutation(destructive, { yes: false, dryRun: false, confirm: "acme" }, captureConfirmation().io)).rejects.toThrow(
      /--yes/,
    );
    await expect(confirmMutation(destructive, { yes: true, dryRun: false, confirm: "other" }, captureConfirmation().io)).rejects.toThrow(
      /--confirm acme/,
    );
    await expect(confirmMutation(destructive, { yes: true, dryRun: false, confirm: "acme" }, captureConfirmation().io)).resolves.toEqual({
      shouldWrite: true,
    });
  });

  it("throws ConfigError when an interactive operator rejects the prompt", async () => {
    const { io, readLine, stdout, stderr } = captureConfirmation({ answer: "n" });

    await expect(confirmMutation(PLAN, { yes: false, dryRun: false }, io)).rejects.toThrow(ConfigError);
    expect(stdout).toEqual([]);
    // The prompt is handed to the reader, never written to stderr first: a
    // readline interface repaints its line on open and erased it, leaving the
    // operator answering a question they could not see.
    expect(readLine).toHaveBeenCalledWith("Proceed? [y/N] ");
    expect(stderr.join("")).not.toContain("Proceed?");
  });

  it("treats a closed prompt as a refusal rather than an error of its own", async () => {
    // Ctrl+D: the reader's contract is an empty string, which must read as "no".
    const { io } = captureConfirmation({ answer: "" });

    await expect(confirmMutation(PLAN, { yes: false, dryRun: false }, io)).rejects.toThrow(/was not confirmed/);
  });

  it("accepts an answer with surrounding whitespace and any casing", async () => {
    for (const answer of ["y", "  y  ", "Y", "yes", "YES\n"]) {
      const { io } = captureConfirmation({ answer });
      await expect(confirmMutation(PLAN, { yes: false, dryRun: false }, io)).resolves.toEqual({ shouldWrite: true });
    }
  });
});
