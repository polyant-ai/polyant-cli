// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { ConfigError } from "./exit.js";

export const CONFIG_FILE = "polyant.yaml";

export interface TargetSpec {
  baseUrl: string;
  /** NAME of the environment variable holding the key — never the value. */
  keyEnv: string;
  prod?: boolean;
}

/** A non-secret, named selection of target and management scope. */
export interface ContextSpec {
  target: string;
  org: string;
  workspace: string;
}

export interface WorkspaceConfig {
  default?: string;
  defaultContext?: string;
  targets: Record<string, TargetSpec>;
  contexts?: Record<string, ContextSpec>;
}

export interface ResolvedTarget {
  name: string;
  baseUrl: string;
  key: string;
  prod: boolean;
}

export interface ResolveOptions {
  config?: WorkspaceConfig;
  env: Record<string, string | undefined>;
  target?: string;
  url?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trailing slashes make `baseUrl + path` ambiguous, so they are dropped here once. */
function normaliseBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/** A literal secret in a versioned file is the one mistake worth refusing outright. */
function rejectLiteralKey(location: string, raw: Record<string, unknown>): void {
  if (!("key" in raw)) return;
  throw new ConfigError(
    `${CONFIG_FILE}: ${location} declares "key". ${CONFIG_FILE} is versioned — ` +
      `use "keyEnv: <ENV_VAR_NAME>" and keep the value in .env.`,
  );
}

/**
 * Shared so a URL from a flag or an env var is validated exactly like one from
 * the config file. Skipping this for the flag path meant a malformed URL failed
 * as a network error — exit 3, which the contract defines as retryable, so an
 * agent would retry a permanently broken URL forever.
 */
function requireHttpUrl(context: string, value: unknown): string {
  if (typeof value !== "string" || !/^https?:\/\//.test(value)) {
    throw new ConfigError(
      `${context} must be a URL starting with http:// or https:// (got ${JSON.stringify(value)}).`,
    );
  }
  return normaliseBaseUrl(value);
}

function requireBaseUrl(name: string, value: unknown): string {
  return requireHttpUrl(`${CONFIG_FILE}: target "${name}" baseUrl`, value);
}

function requireKeyEnv(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(
      `${CONFIG_FILE}: target "${name}" needs "keyEnv", the NAME of the env var holding the key.`,
    );
  }
  return value;
}

function optionalProd(name: string, value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ConfigError(`${CONFIG_FILE}: target "${name}" has a non-boolean "prod".`);
  }
  return value;
}

function validateTarget(name: string, raw: unknown): TargetSpec {
  if (!isRecord(raw)) throw new ConfigError(`${CONFIG_FILE}: target "${name}" must be a mapping.`);
  rejectLiteralKey(`target "${name}"`, raw);
  const prod = optionalProd(name, raw.prod);
  return {
    baseUrl: requireBaseUrl(name, raw.baseUrl),
    keyEnv: requireKeyEnv(name, raw.keyEnv),
    ...(prod === undefined ? {} : { prod }),
  };
}

function requireContextString(name: string, field: "org" | "workspace", value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${CONFIG_FILE}: context "${name}" needs a non-empty string "${field}".`);
  }
  return value;
}

function validateContext(name: string, raw: unknown, targets: Record<string, TargetSpec>): ContextSpec {
  if (!isRecord(raw)) throw new ConfigError(`${CONFIG_FILE}: context "${name}" must be a mapping.`);
  rejectLiteralKey(`context "${name}"`, raw);

  const target = raw.target;
  if (typeof target !== "string" || !Object.hasOwn(targets, target)) {
    throw new ConfigError(`${CONFIG_FILE}: context "${name}" references unknown target ${JSON.stringify(target)}.`);
  }

  return {
    target,
    org: requireContextString(name, "org", raw.org),
    workspace: requireContextString(name, "workspace", raw.workspace),
  };
}

export function parseWorkspaceConfig(text: string): WorkspaceConfig {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${CONFIG_FILE}: invalid YAML — ${reason}`);
  }

  if (!isRecord(doc)) throw new ConfigError(`${CONFIG_FILE}: expected a mapping at the top level.`);
  if (!isRecord(doc.targets) || Object.keys(doc.targets).length === 0) {
    throw new ConfigError(`${CONFIG_FILE}: expected a non-empty "targets" mapping.`);
  }

  const targets: Record<string, TargetSpec> = {};
  for (const [name, raw] of Object.entries(doc.targets)) targets[name] = validateTarget(name, raw);

  const fallback = doc.default;
  if (fallback !== undefined && (typeof fallback !== "string" || !(fallback in targets))) {
    throw new ConfigError(
      `${CONFIG_FILE}: "default" must name one of: ${Object.keys(targets).join(", ")}.`,
    );
  }

  let contexts: Record<string, ContextSpec> | undefined;
  if (doc.contexts !== undefined) {
    if (!isRecord(doc.contexts)) throw new ConfigError(`${CONFIG_FILE}: "contexts" must be a mapping.`);
    contexts = {};
    for (const [name, raw] of Object.entries(doc.contexts)) contexts[name] = validateContext(name, raw, targets);
  }

  const defaultContext = doc.defaultContext;
  if (
    defaultContext !== undefined &&
    (typeof defaultContext !== "string" || contexts === undefined || !Object.hasOwn(contexts, defaultContext))
  ) {
    throw new ConfigError(`${CONFIG_FILE}: "defaultContext" must name a declared context.`);
  }

  return {
    ...(fallback === undefined ? {} : { default: fallback }),
    ...(defaultContext === undefined ? {} : { defaultContext }),
    targets,
    ...(contexts === undefined ? {} : { contexts }),
  };
}

/** Serializes only the validated, non-secret local configuration schema. */
export function serializeWorkspaceConfig(config: WorkspaceConfig): string {
  return stringify(config);
}

/** Absent file is not an error: the CLI then runs on POLYANT_URL + POLYANT_KEY alone. */
export async function loadWorkspaceConfig(path: string = CONFIG_FILE): Promise<WorkspaceConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    // Only "not there" means "no workspace". A file that exists but cannot be
    // read (EACCES, EISDIR) must not masquerade as an absent one, or the user
    // is told to create a file they already have.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot read ${path} — ${reason}`);
  }
  return parseWorkspaceConfig(text);
}

function onlyTargetName(config: WorkspaceConfig): string {
  const names = Object.keys(config.targets);
  if (names.length === 1) return names[0];
  throw new ConfigError(
    `No target selected and no "default" in ${CONFIG_FILE}. ` +
      `Pass --target <name> or set POLYANT_TARGET. Declared: ${names.join(", ")}.`,
  );
}

function resolveFromEnvOnly(opts: ResolveOptions): ResolvedTarget {
  const hint = `Create ${CONFIG_FILE}, or set POLYANT_URL and POLYANT_KEY.`;

  // Silently dropping an explicit --target is the worst failure this module
  // could have: the user names one instance and the CLI writes to another.
  // POLYANT_TARGET is treated leniently by contrast — a shell may export it
  // for a different workspace — but a flag is unambiguous intent.
  if (opts.target !== undefined) {
    throw new ConfigError(
      `--target "${opts.target}" needs a ${CONFIG_FILE} declaring that target, and none was found. ${hint}`,
    );
  }

  const url = opts.url ?? opts.env.POLYANT_URL;
  const key = opts.env.POLYANT_KEY;
  if (!url) throw new ConfigError(`No ${CONFIG_FILE} found and POLYANT_URL is unset. ${hint}`);
  if (!key) throw new ConfigError(`No ${CONFIG_FILE} found and POLYANT_KEY is unset. ${hint}`);
  return {
    name: "env",
    baseUrl: requireHttpUrl(opts.url === undefined ? "POLYANT_URL" : "--url", url),
    key,
    prod: false,
  };
}

export function resolveTarget(opts: ResolveOptions): ResolvedTarget {
  const { config, env } = opts;
  if (!config) return resolveFromEnvOnly(opts);

  const name = opts.target ?? env.POLYANT_TARGET ?? config.default ?? onlyTargetName(config);
  const spec = config.targets[name];
  if (!spec) {
    throw new ConfigError(
      `Unknown target "${name}". Declared: ${Object.keys(config.targets).join(", ")}.`,
    );
  }

  const key = env[spec.keyEnv];
  if (!key) {
    throw new ConfigError(`Target "${name}" reads its key from $${spec.keyEnv}, which is unset or empty.`);
  }

  return {
    name,
    // POLYANT_URL is deliberately NOT consulted here. It exists for the
    // no-config case. Letting a stray export retarget a *named* target would
    // keep that target's key and its `prod` flag while pointing somewhere else,
    // so a write reaching a production host could be labelled `prod: false`.
    // An explicit `--url` is per-invocation intent, so it is honoured.
    baseUrl: opts.url === undefined ? spec.baseUrl : requireHttpUrl("--url", opts.url),
    key,
    prod: spec.prod === true,
  };
}
