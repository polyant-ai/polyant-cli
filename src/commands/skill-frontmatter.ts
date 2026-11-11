// SPDX-License-Identifier: Apache-2.0
import { parse } from "yaml";
import { ConfigError } from "../exit.js";

/** One environment variable a skill declares, in the shape the engine's skill routes take. */
export interface RequiredEnvEntry {
  name: string;
  description?: string;
  sensitive: boolean;
}

// The engine splits a skill the same way: a leading `---` block, then the body.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * The `requiredEnv` a skill declares in its YAML frontmatter, normalised as the
 * engine does it: an entry is a bare string or an object with `name`, and
 * `sensitive` is true unless it is written as `false`. `undefined` means the
 * skill declares none, so the request omits the field.
 */
export function readRequiredEnv(content: string, source: string): RequiredEnvEntry[] | undefined {
  const match = FRONTMATTER.exec(content);
  if (match === null) return undefined;

  let meta: unknown;
  try {
    meta = parse(match[1] ?? "");
  } catch (error) {
    throw new ConfigError(`${source} has frontmatter that is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return undefined;

  const raw = (meta as { requiredEnv?: unknown }).requiredEnv;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ConfigError(`${source}: requiredEnv in the frontmatter must be a list.`);

  const entries: RequiredEnvEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      entries.push({ name: item, sensitive: true });
    } else if (item !== null && typeof item === "object" && "name" in item) {
      const { name, description, sensitive } = item as { name: unknown; description?: unknown; sensitive?: unknown };
      entries.push({
        name: String(name),
        ...(description ? { description: String(description) } : {}),
        sensitive: sensitive !== false,
      });
    } else {
      throw new ConfigError(`${source}: a requiredEnv entry must be a name or an object with a name.`);
    }
  }
  return entries;
}
