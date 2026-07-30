// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { readFile } from "node:fs/promises";
import { request as processRequest, requestStream as processRequestStream, type ApiResponse, type RequestOptions, type StreamResponse } from "../api/client.js";
import type { CommandContext } from "../command.js";
import { loadWorkspaceConfig, type WorkspaceConfig } from "../config.js";
import { ConfigError, RemoteError } from "../exit.js";
import type { ConfirmationIO } from "./confirm.js";
import { processConfirmationIO, readStdin } from "./process-io.js";
import { resolveScope, type ResolvedScope, type ScopeRequirement } from "./scope.js";

/**
 * What every workspace-scoped command family needs. Injected as one object so a
 * test replaces the transport, the configuration and the terminal at once, and
 * so `agent`, `monitor` and `analytics` cannot drift apart on any of the three.
 */
export interface ServiceDependencies {
  request(target: ResolvedScope["target"], opts: RequestOptions): Promise<ApiResponse>;
  requestStream(target: ResolvedScope["target"], opts: RequestOptions): Promise<StreamResponse>;
  loadConfig(): Promise<WorkspaceConfig | undefined>;
  env: Record<string, string | undefined>;
  io: ConfirmationIO;
  /**
   * Reads a payload from a named local file, or from stdin when the source is
   * "-". Channel and hook configuration carries secrets, so it never arrives as
   * a command-line flag where it would land in shell history and `ps` output.
   */
  readPayload(source: string): Promise<string>;
}

export const processServiceDependencies: ServiceDependencies = {
  request: processRequest,
  requestStream: processRequestStream,
  loadConfig: () => loadWorkspaceConfig(),
  env: process.env,
  io: processConfirmationIO,
  readPayload: (source) => (source === "-" ? readStdin() : readFile(source, "utf8")),
};

/**
 * A write must name its workspace; a read need not.
 *
 * A management key has no route that lists the workspaces it may use
 * (`/api/organizations/…` serves human principals only), so requiring one for
 * every read would make the CLI unusable against a real key. For a read the
 * engine's own service-principal resolver picks the organisation's default
 * workspace — the CLI says so on stderr rather than resolving it silently. A
 * write still refuses to proceed without an explicit selection: landing a change
 * in a workspace the operator did not choose is the failure worth preventing.
 */
export type ScopeMode = "read" | "write";

const REQUIRED: Record<ScopeMode, readonly ScopeRequirement[]> = {
  read: ["target"],
  write: ["workspace"],
};

export async function scopeFor(
  deps: ServiceDependencies,
  context: CommandContext | undefined,
  mode: ScopeMode = "write",
): Promise<ResolvedScope> {
  const scope = resolveScope({
    config: await deps.loadConfig(),
    env: deps.env,
    global: context?.global ?? { json: false, yes: false, dryRun: false },
    required: REQUIRED[mode],
  });
  if (mode === "read" && scope.workspace === undefined) {
    deps.io.stderr(
      "note: no workspace selected — reading the organisation's default workspace. " +
        "Pass --workspace <id> or select a context to be explicit.\n",
    );
  }
  return scope;
}

/** Sends a request already bound to the resolved workspace. */
export async function call(deps: ServiceDependencies, scope: ResolvedScope, opts: RequestOptions): Promise<ApiResponse> {
  try {
    return await deps.request(scope.target, withWorkspace(scope, opts));
  } catch (error) {
    throw explainWorkspaceRefusal(error, scope);
  }
}

/**
 * The engine answers an unknown or foreign workspace with a bare 403 — the same
 * answer it gives for a missing permission. Without the distinction an operator
 * cannot tell a wrong id from a wrong key, so the hint names where to look.
 */
function explainWorkspaceRefusal(error: unknown, scope: ResolvedScope): unknown {
  if (!(error instanceof RemoteError) || error.status !== 403 || scope.workspace === undefined) return error;
  return new RemoteError(
    `${error.message} — workspace ${JSON.stringify(scope.workspace)} was sent as x-workspace-slug. ` +
      `Run "polyant-cli whoami" to list the workspaces this key may address.`,
    error.code,
    error.status,
  );
}

export function callStream(deps: ServiceDependencies, scope: ResolvedScope, opts: RequestOptions): Promise<StreamResponse> {
  return deps.requestStream(scope.target, withWorkspace(scope, opts));
}

function withWorkspace(scope: ResolvedScope, opts: RequestOptions): RequestOptions {
  return { ...opts, ...(scope.workspace === undefined ? {} : { workspaceSlug: scope.workspace }) };
}

export function wantsJson(context: CommandContext | undefined): boolean {
  return context?.global.json === true;
}

/** Renders an absent value as absent, so a null never prints as "null". */
export function text(value: unknown): string {
  return value === null || value === undefined ? "-" : String(value);
}

export function expectArray<T>(value: unknown, source: string): T[] {
  if (!Array.isArray(value)) throw new ConfigError(`${source} did not return the expected array.`);
  return value as T[];
}

/** Rejects a flag value that is not a positive integer, before it reaches a query. */
export function positiveInteger(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) throw new ConfigError(`${flag} needs a positive integer.`);
  return value;
}

export function maybe(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}
