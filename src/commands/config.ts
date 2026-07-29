// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command, CommandContext } from "../command.js";
import { CONFIG_FILE, parseWorkspaceConfig, serializeWorkspaceConfig, type WorkspaceConfig } from "../config.js";
import { ConfigError } from "../exit.js";
import { confirmMutation, type ConfirmationIO } from "../runtime/confirm.js";

export interface ConfigFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, text: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface ConfigCommandDependencies {
  readonly configPath: string;
  readonly env: Record<string, string | undefined>;
  readonly fs: ConfigFileSystem;
  readonly io: ConfirmationIO;
  /** Asks only for non-secret configuration values. */
  prompt(question: string): Promise<string>;
  /** Lets tests prove the temporary file is a sibling without nondeterminism. */
  temporaryName(): string;
}

function processPrompt(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  return terminal.question(question).finally(() => terminal.close());
}

const processDependencies: ConfigCommandDependencies = {
  configPath: CONFIG_FILE,
  env: process.env,
  fs: { readFile, writeFile, rename },
  io: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    input: {
      isTTY: process.stdin.isTTY,
      readLine: async () => processPrompt(""),
    },
  },
  prompt: processPrompt,
  temporaryName: () => join(dirname(CONFIG_FILE), `.${basename(CONFIG_FILE)}.${process.pid}.${Date.now()}.tmp`),
};

function configForInit(target: string, baseUrl: string, keyEnv: string, prod: boolean): WorkspaceConfig {
  return {
    default: target,
    targets: { [target]: { baseUrl, keyEnv, ...(prod ? { prod: true } : {}) } },
  };
}

function diffYaml(previous: string | undefined, next: string, path: string): string {
  const removed = previous === undefined ? [] : previous.split("\n").filter((line, index, all) => index < all.length - 1 || line !== "");
  const added = next.split("\n").filter((line, index, all) => index < all.length - 1 || line !== "");
  return [
    `--- ${previous === undefined ? "/dev/null" : path}`,
    `+++ ${path}`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
}

async function readExisting(deps: ConfigCommandDependencies): Promise<string | undefined> {
  try {
    return await deps.fs.readFile(deps.configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot read ${deps.configPath} — ${reason}`);
  }
}

async function writeYaml(deps: ConfigCommandDependencies, previous: string | undefined, next: string, title: string, changes: string[], context: CommandContext | undefined): Promise<void> {
  deps.io.stderr(`${diffYaml(previous, next, deps.configPath)}\n`);
  const decision = await confirmMutation(
    { title, scope: { target: "local configuration", prod: false }, changes },
    { yes: context?.global.yes ?? false, dryRun: context?.global.dryRun ?? false },
    deps.io,
  );
  if (!decision.shouldWrite) return;
  const temporary = deps.temporaryName();
  if (dirname(temporary) !== dirname(deps.configPath)) {
    throw new ConfigError(`Temporary configuration path must be a sibling of ${deps.configPath}.`);
  }
  await deps.fs.writeFile(temporary, next, "utf8");
  await deps.fs.rename(temporary, deps.configPath);
}

function takeValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new ConfigError(`${flag} needs a value.`);
  return value;
}

function onlyKnown(args: string[], permitted: readonly string[], booleanFlags: readonly string[] = ["--prod", "--force", "--no-prod"]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    if (!permitted.includes(arg)) throw new ConfigError(`Unknown config option ${arg}.`);
    if (!booleanFlags.includes(arg)) index += 1;
  }
}

async function init(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  onlyKnown(args, ["--url", "--key-env", "--prod", "--force"]);
  const existing = await readExisting(deps);
  if (existing !== undefined && !args.includes("--force")) {
    throw new ConfigError(`${deps.configPath} already exists; pass --force to replace it.`);
  }

  const target = (context?.global.target ?? (await deps.prompt("Target name [dev]: ")).trim()) || "dev";
  const baseUrl = takeValue(args, "--url") ?? (await deps.prompt("Base URL: ")).trim();
  const keyEnv = takeValue(args, "--key-env") ?? (await deps.prompt("Management key environment variable name: ")).trim();
  if (baseUrl.length === 0) throw new ConfigError("--url needs a value.");
  if (keyEnv.length === 0) throw new ConfigError("--key-env needs a value.");

  const yaml = serializeWorkspaceConfig(
    parseWorkspaceConfig(serializeWorkspaceConfig(configForInit(target, baseUrl, keyEnv, args.includes("--prod")))),
  );
  await writeYaml(deps, existing, yaml, "Initialize local Polyant configuration", [`Set default target to ${target}.`], context);
}

async function validate(deps: ConfigCommandDependencies): Promise<void> {
  const existing = await readExisting(deps);
  if (existing === undefined) throw new ConfigError(`Cannot validate: ${deps.configPath} does not exist.`);
  parseWorkspaceConfig(existing);
  deps.io.stdout(`${deps.configPath} is valid.\n`);
}

async function show(deps: ConfigCommandDependencies): Promise<void> {
  const existing = await readExisting(deps);
  if (existing === undefined) throw new ConfigError(`Cannot show: ${deps.configPath} does not exist.`);
  // Re-serialise the parsed schema, rather than echoing bytes from disk. This
  // means a malformed file that contains a literal `key:` is rejected before
  // anything reaches stdout, and unknown fields cannot become an accidental
  // secret-display channel.
  deps.io.stdout(serializeWorkspaceConfig(parseWorkspaceConfig(existing)));
}

async function doctor(deps: ConfigCommandDependencies): Promise<void> {
  const existing = await readExisting(deps);
  if (existing === undefined) throw new ConfigError(`Cannot run doctor: ${deps.configPath} does not exist.`);
  const config = parseWorkspaceConfig(existing);
  const lines = [`${deps.configPath}: valid`];
  for (const name of Object.keys(config.targets).sort()) {
    const keyEnv = config.targets[name].keyEnv;
    // A presence check is deliberately the only interaction with the secret:
    // diagnostic output may name the expected variable but must never carry it.
    lines.push(`target ${name}: ${keyEnv} is ${deps.env[keyEnv] ? "set" : "unset"}`);
  }
  deps.io.stdout(`${lines.join("\n")}\n`);
}

async function requireConfig(deps: ConfigCommandDependencies): Promise<{ text: string; config: WorkspaceConfig }> {
  const text = await readExisting(deps);
  if (text === undefined) throw new ConfigError(`${deps.configPath} does not exist; run config init first.`);
  return { text, config: parseWorkspaceConfig(text) };
}

async function addTarget(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  const [name] = args;
  if (name === undefined || name.startsWith("--")) throw new ConfigError("config target add needs a target name.");
  const options = args.slice(1);
  onlyKnown(options, ["--url", "--key-env", "--prod"]);
  const url = takeValue(options, "--url");
  const keyEnv = takeValue(options, "--key-env");
  if (url === undefined) throw new ConfigError("config target add needs --url <baseUrl>.");
  if (keyEnv === undefined) throw new ConfigError("config target add needs --key-env <ENV_VAR_NAME>.");

  const { text, config } = await requireConfig(deps);
  if (Object.hasOwn(config.targets, name)) throw new ConfigError(`Target ${JSON.stringify(name)} already exists; use config target edit.`);
  const next: WorkspaceConfig = {
    ...config,
    targets: { ...config.targets, [name]: { baseUrl: url, keyEnv, ...(options.includes("--prod") ? { prod: true } : {}) } },
  };
  const yaml = serializeWorkspaceConfig(parseWorkspaceConfig(serializeWorkspaceConfig(next)));
  await writeYaml(deps, text, yaml, `Add target ${name}`, [`Add target ${name} with key environment name ${keyEnv}.`], context);
}

async function editTarget(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  const [name] = args;
  if (name === undefined || name.startsWith("--")) throw new ConfigError("config target edit needs a target name.");
  const options = args.slice(1);
  onlyKnown(options, ["--url", "--key-env", "--prod", "--no-prod"]);
  if (options.includes("--prod") && options.includes("--no-prod")) throw new ConfigError("Use only one of --prod or --no-prod.");
  const { text, config } = await requireConfig(deps);
  const target = config.targets[name];
  if (target === undefined) throw new ConfigError(`Unknown target ${JSON.stringify(name)}.`);
  if (options.length === 0) throw new ConfigError("config target edit needs at least one change.");
  const prod = options.includes("--prod") ? true : options.includes("--no-prod") ? false : target.prod === true;
  const next: WorkspaceConfig = {
    ...config,
    targets: {
      ...config.targets,
      [name]: {
        baseUrl: takeValue(options, "--url") ?? target.baseUrl,
        keyEnv: takeValue(options, "--key-env") ?? target.keyEnv,
        ...(prod ? { prod: true } : {}),
      },
    },
  };
  const yaml = serializeWorkspaceConfig(parseWorkspaceConfig(serializeWorkspaceConfig(next)));
  await writeYaml(deps, text, yaml, `Edit target ${name}`, [`Update target ${name}.`], context);
}

async function defaultTarget(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  const [name] = args;
  if (name === undefined || name.startsWith("--") || args.length !== 1) throw new ConfigError("config target default needs one target name.");
  const { text, config } = await requireConfig(deps);
  if (!Object.hasOwn(config.targets, name)) throw new ConfigError(`Unknown target ${JSON.stringify(name)}.`);
  const yaml = serializeWorkspaceConfig({ ...config, default: name });
  await writeYaml(deps, text, yaml, `Set default target to ${name}`, [`Select ${name} when no target is specified.`], context);
}

async function removeTarget(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  const [name] = args;
  if (name === undefined || name.startsWith("--") || args.length !== 1) throw new ConfigError("config target remove needs one target name.");
  const { text, config } = await requireConfig(deps);
  if (!Object.hasOwn(config.targets, name)) throw new ConfigError(`Unknown target ${JSON.stringify(name)}.`);
  if (config.default === name) throw new ConfigError(`Target ${JSON.stringify(name)} is the default; select another default before removing it.`);
  const referencedBy = Object.keys(config.contexts ?? {}).filter((contextName) => config.contexts?.[contextName].target === name);
  if (referencedBy.length > 0) {
    throw new ConfigError(`Target ${JSON.stringify(name)} is used by context(s): ${referencedBy.join(", ")}. Update or remove those contexts first.`);
  }
  const { [name]: _removed, ...targets } = config.targets;
  const yaml = serializeWorkspaceConfig({ ...config, targets });
  await writeYaml(deps, text, yaml, `Remove target ${name}`, [`Remove target ${name}.`], context);
}

function requiredContextValue(value: string | undefined, flag: "--target" | "--org" | "--workspace"): string {
  if (value === undefined || value.trim().length === 0) throw new ConfigError(`config context needs ${flag} <value>.`);
  return value;
}

function contextValues(options: string[], context: CommandContext | undefined): { target: string; org: string; workspace: string } {
  onlyKnown(options, ["--target", "--org", "--workspace"]);
  return {
    target: requiredContextValue(takeValue(options, "--target") ?? context?.global.target, "--target"),
    org: requiredContextValue(takeValue(options, "--org") ?? context?.global.org, "--org"),
    workspace: requiredContextValue(takeValue(options, "--workspace") ?? context?.global.workspace, "--workspace"),
  };
}

async function addContext(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  const [name] = args;
  if (name === undefined || name.startsWith("--")) throw new ConfigError("config context add needs a context name.");
  const { text, config } = await requireConfig(deps);
  if (Object.hasOwn(config.contexts ?? {}, name)) throw new ConfigError(`Context ${JSON.stringify(name)} already exists; use config context edit.`);
  const values = contextValues(args.slice(1), context);
  if (!Object.hasOwn(config.targets, values.target)) throw new ConfigError(`Unknown target ${JSON.stringify(values.target)}.`);
  const yaml = serializeWorkspaceConfig(
    parseWorkspaceConfig(
      serializeWorkspaceConfig({ ...config, contexts: { ...(config.contexts ?? {}), [name]: values } }),
    ),
  );
  await writeYaml(deps, text, yaml, `Add context ${name}`, [`Add context ${name} for ${values.target}/${values.org}/${values.workspace}.`], context);
}

function optionalContextValues(options: string[], context: CommandContext | undefined): Partial<{ target: string; org: string; workspace: string }> {
  onlyKnown(options, ["--target", "--org", "--workspace"]);
  const localTarget = takeValue(options, "--target");
  const localOrg = takeValue(options, "--org");
  const localWorkspace = takeValue(options, "--workspace");
  const values = {
    ...(localTarget === undefined && context?.global.target === undefined ? {} : { target: requiredContextValue(localTarget ?? context?.global.target, "--target") }),
    ...(localOrg === undefined && context?.global.org === undefined ? {} : { org: requiredContextValue(localOrg ?? context?.global.org, "--org") }),
    ...(localWorkspace === undefined && context?.global.workspace === undefined ? {} : { workspace: requiredContextValue(localWorkspace ?? context?.global.workspace, "--workspace") }),
  };
  return values;
}

async function editContext(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  const [name] = args;
  if (name === undefined || name.startsWith("--")) throw new ConfigError("config context edit needs a context name.");
  const { text, config } = await requireConfig(deps);
  const current = config.contexts?.[name];
  if (current === undefined) throw new ConfigError(`Unknown context ${JSON.stringify(name)}.`);
  const changes = optionalContextValues(args.slice(1), context);
  if (Object.keys(changes).length === 0) throw new ConfigError("config context edit needs at least one scope option.");
  const nextContext = { ...current, ...changes };
  if (!Object.hasOwn(config.targets, nextContext.target)) throw new ConfigError(`Unknown target ${JSON.stringify(nextContext.target)}.`);
  const yaml = serializeWorkspaceConfig(
    parseWorkspaceConfig(serializeWorkspaceConfig({ ...config, contexts: { ...config.contexts, [name]: nextContext } })),
  );
  await writeYaml(deps, text, yaml, `Edit context ${name}`, [`Update context ${name}.`], context);
}

async function defaultContext(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  const [name] = args;
  if (name === undefined || name.startsWith("--") || args.length !== 1) throw new ConfigError("config context default needs one context name.");
  const { text, config } = await requireConfig(deps);
  if (!Object.hasOwn(config.contexts ?? {}, name)) throw new ConfigError(`Unknown context ${JSON.stringify(name)}.`);
  const yaml = serializeWorkspaceConfig({ ...config, defaultContext: name });
  await writeYaml(deps, text, yaml, `Set default context to ${name}`, [`Select ${name} when no context is specified.`], context);
}

async function removeContext(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  const [name] = args;
  if (name === undefined || name.startsWith("--") || args.length !== 1) throw new ConfigError("config context remove needs one context name.");
  const { text, config } = await requireConfig(deps);
  if (!Object.hasOwn(config.contexts ?? {}, name)) throw new ConfigError(`Unknown context ${JSON.stringify(name)}.`);
  if (config.defaultContext === name) throw new ConfigError(`Context ${JSON.stringify(name)} is the default; select another default before removing it.`);
  const { [name]: _removed, ...contexts } = config.contexts ?? {};
  const next: WorkspaceConfig = { ...config, ...(Object.keys(contexts).length === 0 ? { contexts: undefined } : { contexts }) };
  const yaml = serializeWorkspaceConfig(next);
  await writeYaml(deps, text, yaml, `Remove context ${name}`, [`Remove context ${name}.`], context);
}

async function runConfig(args: string[], context: CommandContext | undefined, deps: ConfigCommandDependencies): Promise<void> {
  const [action, ...rest] = args;
  if (action === "init") return init(rest, context, deps);
  if (action === "validate") return validate(deps);
  if (action === "show") return show(deps);
  if (action === "doctor") return doctor(deps);
  if (action === "target" && rest[0] === "add") return addTarget(rest.slice(1), context, deps);
  if (action === "target" && rest[0] === "edit") return editTarget(rest.slice(1), context, deps);
  if (action === "target" && rest[0] === "default") return defaultTarget(rest.slice(1), context, deps);
  if (action === "target" && rest[0] === "remove") return removeTarget(rest.slice(1), context, deps);
  if (action === "context" && rest[0] === "add") return addContext(rest.slice(1), context, deps);
  if (action === "context" && rest[0] === "edit") return editContext(rest.slice(1), context, deps);
  if (action === "context" && rest[0] === "default") return defaultContext(rest.slice(1), context, deps);
  if (action === "context" && rest[0] === "remove") return removeContext(rest.slice(1), context, deps);
  throw new ConfigError(`Unknown config action ${JSON.stringify(action)}.`);
}

export function createConfigCommand(overrides: Partial<ConfigCommandDependencies> = {}): Command {
  const deps = { ...processDependencies, ...overrides };
  return {
    summary: "manage local Polyant configuration",
    usage: "Usage: polyant-cli config <action> [options]",
    supportsDryRun: true,
    children: {
      init: {
        summary: "create polyant.yaml without storing a key",
        usage: "Usage: polyant-cli config init --target <name> --url <baseUrl> --key-env <ENV> [--prod] [--force]",
        supportsDryRun: true,
        run: (args, context) => runConfig(["init", ...args], context, deps),
      },
      validate: {
        summary: "validate polyant.yaml without reading a key",
        usage: "Usage: polyant-cli config validate",
        run: (args, context) => runConfig(["validate", ...args], context, deps),
      },
      show: {
        summary: "print the versioned local configuration",
        usage: "Usage: polyant-cli config show",
        run: (args, context) => runConfig(["show", ...args], context, deps),
      },
      doctor: {
        summary: "check configuration and key environment names safely",
        usage: "Usage: polyant-cli config doctor",
        run: (args, context) => runConfig(["doctor", ...args], context, deps),
      },
      target: {
        summary: "manage non-secret target declarations",
        usage: "Usage: polyant-cli config target <action> [options]",
        children: {
          add: {
            summary: "add a target declaration",
            usage: "Usage: polyant-cli config target add <name> --url <baseUrl> --key-env <ENV> [--prod]",
            supportsDryRun: true,
            run: (args, context) => runConfig(["target", "add", ...args], context, deps),
          },
          edit: {
            summary: "edit a target declaration",
            usage: "Usage: polyant-cli config target edit <name> [--url <baseUrl>] [--key-env <ENV>] [--prod|--no-prod]",
            supportsDryRun: true,
            run: (args, context) => runConfig(["target", "edit", ...args], context, deps),
          },
          default: {
            summary: "select the default target",
            usage: "Usage: polyant-cli config target default <name>",
            supportsDryRun: true,
            run: (args, context) => runConfig(["target", "default", ...args], context, deps),
          },
          remove: {
            summary: "remove an unused non-default target",
            usage: "Usage: polyant-cli config target remove <name>",
            supportsDryRun: true,
            run: (args, context) => runConfig(["target", "remove", ...args], context, deps),
          },
        },
      },
      context: {
        summary: "manage non-secret target and scope shortcuts",
        usage: "Usage: polyant-cli config context <action> [options]",
        children: {
          add: {
            summary: "add a target/org/workspace shortcut",
            usage: "Usage: polyant-cli config context add <name> --target <target> --org <org> --workspace <workspace>",
            supportsDryRun: true,
            run: (args, context) => runConfig(["context", "add", ...args], context, deps),
          },
          edit: {
            summary: "edit a target/org/workspace shortcut",
            usage: "Usage: polyant-cli config context edit <name> [--target <target>] [--org <org>] [--workspace <workspace>]",
            supportsDryRun: true,
            run: (args, context) => runConfig(["context", "edit", ...args], context, deps),
          },
          default: {
            summary: "select the default context",
            usage: "Usage: polyant-cli config context default <name>",
            supportsDryRun: true,
            run: (args, context) => runConfig(["context", "default", ...args], context, deps),
          },
          remove: {
            summary: "remove a non-default context",
            usage: "Usage: polyant-cli config context remove <name>",
            supportsDryRun: true,
            run: (args, context) => runConfig(["context", "remove", ...args], context, deps),
          },
        },
      },
    },
    run: (args, context) => runConfig(args, context, deps),
  };
}

export const configCommand = createConfigCommand();
