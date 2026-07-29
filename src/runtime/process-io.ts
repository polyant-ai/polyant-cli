// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { ConfirmationIO } from "./confirm.js";

/**
 * The real process streams behind the boundary commands replace in tests.
 *
 * Kept in its own module, free of any transport import: `api` needs the terminal
 * without needing the workspace-scoped service plumbing, and pulling that in
 * would make every `api` test mock the streaming client it never calls.
 */

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export const processConfirmationIO: ConfirmationIO = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  input: { isTTY: process.stdin.isTTY, readLine: readStdin },
};
