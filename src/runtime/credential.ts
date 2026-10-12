// SPDX-License-Identifier: Apache-2.0
import { ConfigError } from "../exit.js";
import type { ResolvedScope } from "./scope.js";

/**
 * Which credential is on the header. A personal token cannot read
 * /api/service-context, a management key cannot read /api/me, so a caller
 * reading a 403 needs to know which of the two it presented. `unknown` is
 * honest about a key whose prefix the CLI does not recognise rather than
 * guessing at "management".
 */
export type CredentialKind = "management-key" | "personal-token" | "unknown";

/**
 * The engine tells the two credentials apart by prefix on one header, so the CLI
 * can too — without a request, and before any route is chosen.
 */
export function credentialKind(key: string): CredentialKind {
  if (key.startsWith("pat_")) return "personal-token";
  if (key.startsWith("pk_")) return "management-key";
  return "unknown";
}

/**
 * Creating or changing a management key or a role refuses a personal token
 * (engine 1.2.0): a token that can issue credentials, or widen what one may do,
 * survives its own revocation — whoever holds a leaked one issues a successor
 * first. The engine answers 403; refused here instead, before any read, naming
 * what does work.
 */
export function refusePersonalToken(scope: ResolvedScope, action: string): void {
  if (credentialKind(scope.target.key) !== "personal-token") return;
  throw new ConfigError(
    `polyant-cli ${action} cannot run on a personal token: the engine reserves it for an interactive session ` +
      "or a management key. Use a management key with org:write, or the web console.",
  );
}
