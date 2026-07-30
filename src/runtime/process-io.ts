// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { createInterface } from "node:readline/promises";
import type { ConfirmationIO } from "./confirm.js";

/**
 * The real process streams behind the boundary commands replace in tests.
 *
 * Kept in its own module, free of any transport import: `api` needs the terminal
 * without needing the workspace-scoped service plumbing, and pulling that in
 * would make every `api` test mock the streaming client it never calls.
 */

/** Drains stdin to EOF. For a payload (`--data -`, `--file -`), never for a prompt. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads exactly one line, showing `prompt` on stderr so machine stdout stays
 * clean. Draining stdin here instead would hang a terminal forever: a keyboard
 * sends no EOF, so the answer would never arrive.
 */
export async function askLine(prompt: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(prompt);
  } catch {
    // Ctrl+D closes the interface. An unanswered prompt is a refusal, not a
    // crash, so the caller's policy reports it rather than the runtime.
    return "";
  } finally {
    terminal.close();
  }
}

export const processConfirmationIO: ConfirmationIO = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  input: { isTTY: process.stdin.isTTY, readLine: askLine },
};
