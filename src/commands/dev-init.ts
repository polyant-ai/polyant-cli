// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { confirmMutation } from "../runtime/confirm.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import type { DevCommandDependencies } from "./dev.js";

/**
 * The scaffold for a dev-mode tool project.
 *
 * It writes the two things `dev connect` cannot work without, and which nothing
 * else can supply for the operator: `tsx`, because a `*.tool.ts` file has to be
 * imported by a TypeScript-capable process, and `@polyant-ai/plugin-sdk`,
 * because the bare specifier in a tool file resolves from THIS directory's
 * node_modules and nowhere else. The example tool is there to be edited.
 *
 * The scope of the recap is the local filesystem, not a target: nothing here
 * reaches the engine, so requiring `--org/--workspace` would be a lie about
 * what is at stake. Same shape as `config init`.
 */

/**
 * The SDK is taken by git tag, not from a registry: the dev runtime ships in
 * `@polyant-ai/plugin-sdk/dev` and this repository does not publish it. A tag
 * pins a resolvable tree, where a branch would silently move under the project.
 */
const SDK_SPECIFIER = "git+https://github.com/polyant-ai/polyant-sdk.git#v1.6.0";
const ZOD_SPECIFIER = "^3.23.0";
const TSX_SPECIFIER = "^4.19.0";

const AGENT_PLACEHOLDER = "<agent-slug>";

interface ScaffoldFile {
  readonly path: string;
  readonly content: string;
}

function packageJson(name: string, agent: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      scripts: {
        // The CLI is the entry point, not a local runner script: `dev connect`
        // owns the token, the target and the child process.
        dev: `polyant-cli dev connect ${agent} --watch`,
      },
      dependencies: {
        "@polyant-ai/plugin-sdk": SDK_SPECIFIER,
        zod: ZOD_SPECIFIER,
      },
      devDependencies: {
        tsx: TSX_SPECIFIER,
      },
    },
    null,
    2,
  )}\n`;
}

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ["**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2,
)}\n`;

const EXAMPLE_TOOL = `import { z } from "zod";
import { defineTool } from "@polyant-ai/plugin-sdk";

/**
 * A tool served from this machine into a remote agent, for one turn at a time.
 *
 * \`parameters\` is static and must satisfy OpenAI strict mode: no .optional(),
 * no .default(), no .url()/.email(), no unbounded z.record(). \`execute\` gets
 * the real ToolContext — its secrets, state and audit are the engine's, proxied
 * over the dev socket.
 *
 * A name that collides with a tool the agent already has REPLACES it for the
 * turn. That is the only way to substitute one, and it is deliberate.
 */
export default defineTool({
  name: "local_echo",
  description: "Echo a string back. Replace this with the tool you are writing.",
  parameters: z.object({
    text: z.string().describe("The text to echo back"),
  }),
  execute: async (input) => ({ status: "ok", echoed: input.text }),
});
`;

const GITIGNORE = "node_modules/\n";

function scaffold(name: string, agent: string): readonly ScaffoldFile[] {
  return [
    { path: "package.json", content: packageJson(name, agent) },
    { path: "tsconfig.json", content: TSCONFIG },
    { path: ".gitignore", content: GITIGNORE },
    { path: join("tools", "local-echo.tool.ts"), content: EXAMPLE_TOOL },
  ];
}

function targetDirectory(args: readonly string[], deps: DevCommandDependencies): string {
  const first = args[0];
  const given = first === undefined || first.startsWith("--") ? "." : first;
  return isAbsolute(given) ? given : resolve(deps.cwd(), given);
}

/** A package name npm will accept: lower case, no spaces, never empty. */
function projectName(directory: string): string {
  const base = directory.split("/").filter((segment) => segment.length > 0).pop() ?? "polyant-tools";
  const cleaned = base.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[._-]+/, "");
  return cleaned.length === 0 ? "polyant-tools" : cleaned;
}

export async function devInit(
  args: string[],
  context: CommandContext | undefined,
  deps: DevCommandDependencies,
): Promise<void> {
  const options = args[0] === undefined || args[0].startsWith("--") ? args : args.slice(1);
  assertKnown(options, { value: ["--agent"], boolean: ["--force"] }, "dev init option");
  const directory = targetDirectory(args, deps);
  const agent = takeValue(options, "--agent") ?? AGENT_PLACEHOLDER;
  const force = options.includes("--force");

  const files = scaffold(projectName(directory), agent);
  const existing: string[] = [];
  for (const file of files) {
    if (await deps.fs.exists(join(directory, file.path))) existing.push(file.path);
  }
  // Named, all of them, before anything is written: "some file existed" sends
  // the operator looking, and a partial scaffold is the worst outcome here.
  if (existing.length > 0 && !force) {
    throw new ConfigError(
      `${directory} already contains ${existing.join(", ")}; pass --force to replace ${existing.length === 1 ? "it" : "them"}.`,
    );
  }

  const decision = await confirmMutation(
    {
      title: `Scaffold a Polyant dev-tools project in ${directory}`,
      scope: { target: "local filesystem", prod: false },
      changes: files.map((file) => `${existing.includes(file.path) ? "Replace" : "Write"} ${file.path}.`),
    },
    { yes: context?.global.yes ?? false, dryRun: context?.global.dryRun ?? false },
    deps.io,
  );
  if (!decision.shouldWrite) return;

  for (const file of files) {
    const absolute = join(directory, file.path);
    await deps.fs.mkdir(dirname(absolute), { recursive: true });
    await deps.fs.writeFile(absolute, file.content, "utf8");
  }

  deps.io.stdout(`${files.map((file) => join(directory, file.path)).join("\n")}\n`);
  deps.io.stderr(
    `Next: npm install in ${directory}, then \`npm run dev\`${
      agent === AGENT_PLACEHOLDER ? ` after replacing ${AGENT_PLACEHOLDER} in package.json` : ""
    }.\n`,
  );
}
