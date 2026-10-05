// Runs every read-only CLI leaf that needs nothing but an agent or workspace
// slug, against the ephemeral engine, and reports each exit code. The list comes
// from `polyant-cli --json`, so a command added or removed is covered without
// editing this file.
//
// Usage: node smoke.mjs <wrapper> <agentSlug> [workspaceSlug]
// Exit 0 when every leaf exited 0 or 1 (1 is a check that held, e.g. checkup);
// otherwise 1, after printing each failure and its stderr.
import { execFileSync, spawnSync } from "node:child_process";

const [wrapper, agent, workspace = "general"] = process.argv.slice(2);
if (!wrapper || !agent) {
  console.error("usage: node smoke.mjs <wrapper> <agentSlug> [workspaceSlug]");
  process.exit(2);
}

const tree = JSON.parse(execFileSync(wrapper, ["--json"], { encoding: "utf8" }));
const leaves = [];
const walk = (node) => (node.children?.length ? node.children.forEach(walk) : leaves.push(node));
tree.commands.forEach(walk);

const FILL = { "<slug>": agent, "<workspaceSlug>": workspace, "<ws>": workspace };
// Long-running or input-driven reads: exercised by hand, never in a loop.
const SKIP = new Set(["agent chat", "dev connect", "agent mcp test"]);

const runnable = [];
for (const leaf of leaves) {
  if (leaf.supportsDryRun || SKIP.has(leaf.path)) continue;
  const line = leaf.usage.split("\n")[0].replace(/^Usage: polyant-cli /, "").slice(leaf.path.length).trim();
  // Required arguments are what precedes the first optional or grouped part.
  const required = line.split(/\s+(?=[[(]|--)/)[0].split(/\s+/).filter(Boolean);
  if (line.startsWith("[") || line.startsWith("(")) required.length = 0;
  if (required.every((token) => token in FILL)) runnable.push([leaf.path, required.map((t) => FILL[t])]);
}

const scope = ["--org", "default", "--workspace", workspace];
let failed = 0;
for (const [path, args] of runnable) {
  const res = spawnSync(wrapper, [...scope, ...path.split(" "), ...args], { encoding: "utf8", timeout: 60_000 });
  const code = res.status ?? -1;
  const ok = code === 0 || code === 1;
  if (!ok) failed += 1;
  console.log(`${String(code).padEnd(3)} ${path}`);
  if (!ok) console.log(`    ${(res.stderr || res.error?.message || "").trim().split("\n").slice(-2).join("\n    ")}`);
}
console.log(`\n${runnable.length} leaves run, ${failed} failed, ${leaves.length - runnable.length} skipped (writes, or arguments beyond a slug).`);
process.exit(failed === 0 ? 0 : 1);
