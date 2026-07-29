// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { type ContextSpec, resolveTarget, type ResolvedTarget, type WorkspaceConfig } from "../config.js";
import { ConfigError } from "../exit.js";
import type { GlobalOptions } from "./global-options.js";

/** Components a command may require before it performs a scoped operation. */
export type ScopeRequirement = "target" | "org" | "workspace";

export interface ResolvedScope {
  target: ResolvedTarget;
  context?: string;
  org?: string;
  workspace?: string;
}

/**
 * Resolves non-secret scope from parsed configuration and the global CLI flags.
 * Values from the environment deliberately participate only in target/key
 * resolution; org and workspace must be selected explicitly or by a context.
 */
export interface ResolveScopeOptions {
  config?: WorkspaceConfig;
  env: Record<string, string | undefined>;
  global: GlobalOptions;
  /** A command-local base URL override, validated by resolveTarget. */
  url?: string;
  required?: readonly ScopeRequirement[];
}

interface SelectedContext {
  name: string;
  spec: ContextSpec;
}

function selectContext(config: WorkspaceConfig | undefined, global: GlobalOptions): SelectedContext | undefined {
  const name = global.context ?? config?.defaultContext;
  if (name === undefined) return undefined;

  const contexts = config?.contexts;
  const spec = contexts !== undefined && Object.hasOwn(contexts, name) ? contexts[name] : undefined;
  if (spec !== undefined) return { name, spec };

  const declared = Object.keys(contexts ?? {});
  throw new ConfigError(
    `Unknown context "${name}". Declared: ${declared.length === 0 ? "(none)" : declared.join(", ")}.`,
  );
}

function requireComponents(scope: ResolvedScope, requirements: readonly ScopeRequirement[]): void {
  const required = new Set(requirements);
  if (required.has("workspace")) required.add("org");

  const values: Record<ScopeRequirement, string | ResolvedTarget | undefined> = {
    target: scope.target,
    org: scope.org,
    workspace: scope.workspace,
  };
  for (const component of ["target", "org", "workspace"] as const) {
    const value = values[component];
    const isPresent = component === "target" ? value !== undefined : typeof value === "string" && value.trim().length > 0;
    if (required.has(component) && !isPresent) {
      throw new ConfigError(`Missing required scope component "${component}".`);
    }
  }
}

/**
 * Resolves flags before a selected context, and lets resolveTarget apply its
 * established target/environment/default behavior when neither supplies one.
 */
export function resolveScope(options: ResolveScopeOptions): ResolvedScope {
  const selected = selectContext(options.config, options.global);
  const scope: ResolvedScope = {
    target: resolveTarget({
      config: options.config,
      env: options.env,
      target: options.global.target ?? selected?.spec.target,
      ...(options.url === undefined ? {} : { url: options.url }),
    }),
    ...(selected === undefined ? {} : { context: selected.name }),
    ...(options.global.org === undefined && selected === undefined
      ? {}
      : { org: options.global.org ?? selected?.spec.org }),
    ...(options.global.workspace === undefined && selected === undefined
      ? {}
      : { workspace: options.global.workspace ?? selected?.spec.workspace }),
  };

  requireComponents(scope, options.required ?? []);
  return scope;
}
