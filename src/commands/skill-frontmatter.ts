// SPDX-License-Identifier: Apache-2.0
import { parse } from "yaml";
import { ConfigError } from "../exit.js";

/** One environment variable a skill declares, in the shape the engine's skill routes take. */
export interface RequiredEnvEntry {
  name: string;
  description?: string;
  sensitive: boolean;
}

/** What a skill declares in its frontmatter; an absent field means the skill declares none, so the request omits it. */
export interface SkillRequirements {
  requiredEnv?: RequiredEnvEntry[];
  requiredTools?: string[];
}

// The engine splits a skill the same way: a leading `---` block, then the body.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * The `requiredEnv` and `requiredTools` a skill declares in its YAML
 * frontmatter, normalised as the engine does it. A `requiredEnv` entry is a
 * bare string or an object with `name`, and `sensitive` is true unless it is
 * written as `false`; a `requiredTools` entry is a tool name.
 */
export function readSkillRequirements(content: string, source: string): SkillRequirements {
  const match = FRONTMATTER.exec(content);
  if (match === null) return {};

  let meta: unknown;
  try {
    meta = parse(match[1] ?? "");
  } catch (error) {
    throw new ConfigError(`${source} has frontmatter that is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return {};

  const { requiredEnv, requiredTools } = meta as { requiredEnv?: unknown; requiredTools?: unknown };
  const env = readList(requiredEnv, "requiredEnv", source)?.map((item) => envEntry(item, source));
  const tools = readList(requiredTools, "requiredTools", source)?.map((item) => {
    if (typeof item !== "string" || item.trim() === "") throw new ConfigError(`${source}: a requiredTools entry must be a tool name.`);
    return item.trim();
  });
  return { ...(env === undefined ? {} : { requiredEnv: env }), ...(tools === undefined ? {} : { requiredTools: tools }) };
}

function readList(raw: unknown, field: string, source: string): unknown[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ConfigError(`${source}: ${field} in the frontmatter must be a list.`);
  return raw;
}

function envEntry(item: unknown, source: string): RequiredEnvEntry {
  if (typeof item === "string") return { name: item, sensitive: true };
  if (item !== null && typeof item === "object" && "name" in item) {
    const { name, description, sensitive } = item as { name: unknown; description?: unknown; sensitive?: unknown };
    return {
      name: String(name),
      ...(description ? { description: String(description) } : {}),
      sensitive: sensitive !== false,
    };
  }
  throw new ConfigError(`${source}: a requiredEnv entry must be a name or an object with a name.`);
}
