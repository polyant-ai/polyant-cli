// SPDX-License-Identifier: Apache-2.0
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { ORG_NOTE, orgPath, preflight, readScope, report, requirePositional, workspaceIdFor } from "../runtime/org.js";
import { call, expectArray, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { Node } from "../runtime/tree.js";

/**
 * How somebody gets INTO the organisation. `member set-role` and
 * `workspace member set` both address a person who is already in it; until this
 * family, the CLI could describe every membership and create none.
 */

interface InvitationRow {
  id: string;
  email: string;
  roleKey: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
}

function invitationsPath(org: string, id?: string): string {
  return orgPath(org, id === undefined ? "/invitations" : `/invitations/${encodeURIComponent(id)}`);
}

async function invitationsList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { boolean: ["--pending-only"] }, "member invitations list option");
  const { scope, org } = await readScope(deps, context);
  const path = invitationsPath(org);
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const all = expectArray<InvitationRow>((res.body as { invitations?: unknown } | null)?.invitations, `GET ${path}`);
  // The engine returns accepted and revoked rows too, which is what makes the
  // listing a history rather than a queue; the filter is local because the route
  // takes no status parameter.
  const invitations = args.includes("--pending-only") ? all.filter((invitation) => invitation.status === "pending") : all;
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "EMAIL", "ROLE", "STATUS", "EXPIRES"],
      rows: invitations.map((invitation) => [
        text(invitation.id),
        text(invitation.email),
        text(invitation.roleKey),
        text(invitation.status),
        text(invitation.expiresAt),
      ]),
      emptyMessage: `Organisation ${org} has no invitations.`,
    })}\n`,
  );
}

async function invitationsCreate(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const email = requirePositional(args, "member invitations create", "email address");
  const options = args.slice(1);
  assertKnown(options, { value: ["--role", "--workspace-role", "--confirm"] }, "member invitations create option");
  const roleKey = takeValue(options, "--role");
  if (roleKey === undefined) throw new ConfigError("polyant-cli member invitations create needs --role <key>.");
  // The global flag, read where the global parser leaves it. Only the flag: a
  // selected context's workspace is where commands act, not where a new member
  // should be bound, so it must not turn into a binding by default.
  const workspace = context?.global.workspace;
  const workspaceRoleKey = takeValue(options, "--workspace-role");
  if (workspaceRoleKey !== undefined && workspace === undefined) {
    throw new ConfigError("--workspace-role needs --workspace <slug>: a workspace role has no meaning without the workspace it applies in.");
  }

  const { scope, org } = await readScope(deps, context);
  // The route takes the workspace's uuid, as `workspace member set` does; the
  // slug is what a person has, so it is resolved here rather than demanded.
  const workspaceId = workspace === undefined ? undefined : await workspaceIdFor(deps, scope, org, workspace);

  const plan = {
    title: `Invite ${email} to ${org}`,
    changes: [
      `Create a pending invitation for ${email} with organisation role ${roleKey}.`,
      ...(workspace === undefined ? [] : [`Bind them to workspace ${workspace}${workspaceRoleKey === undefined ? "" : ` as ${workspaceRoleKey}`} on acceptance.`]),
      "The engine mails the link and also returns it once, so it can be shared by hand if no mailer is configured.",
    ],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: "POST",
    path: invitationsPath(org),
    body: {
      email,
      roleKey,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(workspaceRoleKey === undefined ? {} : { workspaceRoleKey }),
    },
  });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const invitation = (res.body ?? {}) as { invitation?: Record<string, unknown> } & Record<string, unknown>;
  const created = (invitation.invitation ?? invitation) as Record<string, unknown>;
  writePrettyResource(deps.io, [
    { label: "id", value: text(created.id) },
    { label: "email", value: text(created.email) },
    { label: "expiresAt", value: text(created.expiresAt) },
    // Reported rather than assumed: false is exactly when the admin has to fall
    // back to sending the token below by hand, and a create that looked the same
    // either way would hide that.
    { label: "emailSent", value: text(created.emailSent) },
    // Shown once and never again — only its hash is stored. Printed last so a
    // truncated terminal loses the labels, not the token.
    { label: "token", value: text(created.token) },
  ]);
}

async function invitationsRevoke(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const id = requirePositional(args, "member invitations revoke", "invitation id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "member invitations revoke option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Revoke invitation ${id}`,
    changes: [`The link stops working. Somebody who already accepted it keeps their membership — revoke that with \`member remove\`.`],
    destructive: { confirm: id },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: invitationsPath(org, id) });
  report(deps, context, res.raw, `Revoked invitation ${id}.`);
}

const INVITE_NOTE =
  "Needs `org.member:manage`, and Enterprise: the engine gates invitations behind a\nlicensed feature and answers 403 on a deployment without it, the same shape as a\nmissing permission.";

/** The `member invitations` subtree. */
export const memberInvitationsFamily: Record<string, Node> = {
  list: {
    summary: "list the organisation's invitations",
    usage: `Usage: polyant-cli member invitations list [--pending-only]

Accepted and revoked rows are kept, so this is a history rather than a queue.
${INVITE_NOTE} ${ORG_NOTE}`,
    action: invitationsList,
  },
  create: {
    summary: "invite somebody into the organisation",
    usage: `Usage: polyant-cli member invitations create <email> --role <key>
                                          [--workspace <slug>] [--workspace-role <key>]

The token is printed once and never again — the engine keeps only its hash — and
\`emailSent\` says whether the invitation was actually posted, which is when you
need the token by hand.

An address the organisation's SSO sign-in list would later lock out is refused
here rather than at acceptance: the invitation that cannot work never exists.
${INVITE_NOTE} ${ORG_NOTE}`,
    action: invitationsCreate,
    mutates: true,
  },
  revoke: {
    summary: "revoke a pending invitation",
    usage: `Usage: polyant-cli member invitations revoke <invitationId> --yes --confirm <invitationId>

The link stops working. It does nothing to somebody who already accepted — that
is \`member remove\`. ${INVITE_NOTE} ${ORG_NOTE}`,
    action: invitationsRevoke,
    mutates: true,
  },
};
