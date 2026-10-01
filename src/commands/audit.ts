// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { CommandContext } from "../command.js";
import { writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { ORG_NOTE, orgPath, readScope } from "../runtime/org.js";
import { call, expectArray, maybe, positiveInteger, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";

/**
 * The organisation's two audit trails.
 *
 * They answer different questions and the engine keeps them apart, so the CLI
 * does too: `management` is who CHANGED what — one row per mutating management
 * route — and `authz` is who was REFUSED, the authorization decisions. Folding
 * them into one listing would produce a stream in which an absent row means
 * either "nothing was changed" or "nothing was refused", with no way to tell.
 *
 * Neither is `monitor events`, which lists an agent's TOOL events: those are
 * what an agent did on a turn, not what a person did to the configuration.
 */

/** Both listings page the same way, and the engine clamps `limit` at 200. */
function paging(args: readonly string[]): Record<string, string> {
  return {
    ...maybe("limit", positiveInteger(takeValue(args, "--limit"), "--limit")),
    ...maybe("offset", positiveInteger(takeValue(args, "--offset"), "--offset")),
  };
}

interface ManagementAuditRow {
  id: string;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

interface ManagementAuditBody {
  logs?: unknown;
  total?: unknown;
  /** The vocabulary actually present in this organisation's rows. */
  actions?: unknown;
  targetTypes?: unknown;
}

/**
 * `metadata` is where a row says what it actually did — which fields were
 * rotated, which provider, which workspace — and it differs per action. Rendered
 * as compact JSON in its own column rather than dropped: without it a row states
 * that something was updated and never what.
 */
function summariseMetadata(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return "-";
  if (typeof metadata !== "object") return String(metadata);
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length === 0) return "-";
  return entries.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" ");
}

async function managementAudit(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--action", "--actor", "--target-type", "--from", "--to", "--limit", "--offset"] }, "org audit management option");
  const { scope, org } = await readScope(deps, context);
  const path = orgPath(org, "/management-audit-logs");
  const res = await call(deps, scope, {
    path,
    query: {
      ...maybe("action", takeValue(args, "--action")),
      // The engine spells this `actorEmail` and matches on the address, not the
      // user id: a row keeps the email it was written with even after the
      // account is renamed, which is what makes an old trail still readable.
      ...maybe("actorEmail", takeValue(args, "--actor")),
      ...maybe("targetType", takeValue(args, "--target-type")),
      ...maybe("from", takeValue(args, "--from")),
      ...maybe("to", takeValue(args, "--to")),
      ...paging(args),
    },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as ManagementAuditBody;
  const logs = expectArray<ManagementAuditRow>(body.logs, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["WHEN", "ACTOR", "ACTION", "TARGET", "DETAIL"],
      rows: logs.map((row) => [
        text(row.createdAt),
        // The id when the row has no email: a machine principal has no address,
        // and printing "-" for every key-driven change would hide the actor that
        // made most of the rows on a scripted deployment.
        text(row.actorEmail ?? row.actorUserId),
        text(row.action),
        `${text(row.targetType)}/${text(row.targetId)}`,
        summariseMetadata(row.metadata),
      ]),
      emptyMessage: `Organisation ${org} has no management-audit rows matching that filter.`,
    })}\n`,
  );
  // The vocabulary travels with every page, and it is the only way to learn what
  // `--action` and `--target-type` accept: the engine serves no catalogue route.
  const actions = Array.isArray(body.actions) ? (body.actions as string[]) : [];
  const targetTypes = Array.isArray(body.targetTypes) ? (body.targetTypes as string[]) : [];
  deps.io.stderr(
    `total: ${text(body.total)}\n` +
      (actions.length === 0 ? "" : `actions: ${actions.join(", ")}\n`) +
      (targetTypes.length === 0 ? "" : `target types: ${targetTypes.join(", ")}\n`),
  );
}

interface AuthzAuditRow {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string | null;
}

async function authzAudit(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--action", "--limit", "--offset"] }, "org audit authz option");
  const { scope, org } = await readScope(deps, context);
  const path = orgPath(org, "/authz-audit-logs");
  const res = await call(deps, scope, {
    path,
    query: {
      ...maybe("action", takeValue(args, "--action")),
      // A slug here, translated to the id by the engine: the rows carry
      // `metadata.workspaceId`, which nobody reading a trail has to hand. The
      // flag is the global one, so it is read from the context; a selected
      // context's workspace does not narrow the trail.
      ...maybe("workspace", context?.global.workspace),
      ...paging(args),
    },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as { logs?: unknown; total?: unknown };
  const logs = expectArray<AuthzAuditRow>(body.logs, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["WHEN", "ACTOR", "ACTION", "TARGET", "IP", "DETAIL"],
      rows: logs.map((row) => [
        text(row.createdAt),
        text(row.actorUserId),
        text(row.action),
        `${text(row.targetType)}/${text(row.targetId)}`,
        text(row.ipAddress),
        summariseMetadata(row.metadata),
      ]),
      emptyMessage: `Organisation ${org} has no authorization-audit rows matching that filter.`,
    })}\n`,
  );
  deps.io.stderr(`total: ${text(body.total)}\n`);
}

const AUDIT_NOTE =
  "Both listings need `org.audit:read`, which Owner and Admin hold and Member and\nViewer do not. The window is paged: --limit is clamped at 200 by the engine, so\nwalk a long trail with --offset.";

/** The `org audit` subtree, merged into the `org` family. */
export const orgAuditFamily: Record<string, Node> = {
  management: {
    summary: "who changed what in this organisation",
    usage: `Usage: polyant-cli org audit management [--action <name>] [--actor <email>] [--target-type <name>]
                                        [--from <iso>] [--to <iso>] [--limit <n>] [--offset <n>]

One row per mutating management route: the actor, what they touched, and the
detail the route recorded. This is configuration history, not agent activity —
for what an agent DID on a turn, use \`monitor events\`.

The actions and target types present in this organisation are printed on stderr
below the table, because they are what --action and --target-type accept and the
engine serves no catalogue for them.

Not gated behind the advanced-audit entitlement, unlike \`org audit authz\`: the
record of who changed what is the base compliance trail of a deployment.
${AUDIT_NOTE} ${ORG_NOTE}`,
    action: managementAudit,
  },
  authz: {
    summary: "the authorization decisions recorded for this organisation",
    usage: `Usage: polyant-cli org audit authz [--action <name>] [--workspace <slug>] [--limit <n>] [--offset <n>]

Who was allowed or refused, and on what. A different question from
\`org audit management\`, which records the changes that went through — a refusal
leaves no row there, and a successful change leaves none here.

Enterprise, and behind the advanced-audit entitlement: a deployment without it
answers 403, the same shape as a missing permission.
${AUDIT_NOTE} ${ORG_NOTE}`,
    action: authzAudit,
  },
};
