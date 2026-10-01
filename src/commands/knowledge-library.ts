// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import type { WorkspaceSummary, WorkspacesResponse } from "../api/types.js";
import type { CommandContext } from "../command.js";
import { ConfigError } from "../exit.js";
import { writePrettyResource, writeRawResponse } from "../render/output.js";
import { renderTable } from "../render/table.js";
import { assertKnown, takeValue } from "../runtime/flags.js";
import { ORG_NOTE, orgPath, preflight, readScope, report, requirePositional } from "../runtime/org.js";
import { call, expectArray, scopeFor, text, wantsJson, type ServiceDependencies } from "../runtime/service.js";
import type { ResolvedScope } from "../runtime/scope.js";
import type { Node } from "../runtime/tree.js";
import { agentPath, preflight as agentPreflight, reportWrite, requireSecond, requireSlug } from "../runtime/workspace.js";

/**
 * Shared knowledge: a library owned by an organisation or by a workspace, and
 * the switch that puts one of its documents on an agent.
 *
 * Distinct from `agent knowledge`, which is the agent's OWN documents — uploaded
 * to it, deleted with it, reachable by nothing else. A library document is
 * uploaded once and lent: the organisation decides which workspaces may draw on
 * it, and each agent then switches on the ones it wants. Three tiers, and a
 * document has to pass all three to reach a turn.
 *
 * The uploads are multipart, unlike every other write in this CLI: the engine
 * parses them with `FileInterceptor` and a library document is as often a PDF as
 * it is text. That is why they take a path and not `-`.
 */

interface LibraryDocumentRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  chunkCount: number;
  errorMessage: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Which workspaces may draw on it. Always empty for a workspace's own document. */
  workspaceIds: string[];
}

interface LibraryBody {
  documents?: unknown;
  /** The embedder the library is indexed with, or null when none is declared. */
  embedder?: { provider?: unknown; dimensions?: unknown } | null;
}

function orgKnowledgePath(org: string, rest = ""): string {
  return orgPath(org, `/knowledge${rest}`);
}

function workspaceKnowledgePath(org: string, workspace: string, rest = ""): string {
  return orgPath(org, `/workspaces/${encodeURIComponent(workspace)}/knowledge${rest}`);
}

/**
 * An ingestion failure is the row the reader came for, and `status` alone does
 * not say why, so the message rides in the same cell — the same rule
 * `agent knowledge list` already follows.
 */
function statusCell(doc: LibraryDocumentRow): string {
  return doc.errorMessage === null || doc.errorMessage === undefined ? text(doc.status) : `${doc.status}: ${doc.errorMessage}`;
}

function reportEmbedder(deps: ServiceDependencies, body: LibraryBody): void {
  const embedder = body.embedder;
  // Without one nothing in the library is searchable, whatever the agents
  // that draw on it are configured with.
  deps.io.stderr(
    embedder === null || embedder === undefined
      ? "embedder: none declared — nothing in this library is searchable yet.\n"
      : `embedder: ${text(embedder.provider)} (${text(embedder.dimensions)} dimensions)\n`,
  );
}

async function workspaceSlugsById(deps: ServiceDependencies, scope: ResolvedScope, org: string): Promise<Map<string, string>> {
  const path = orgPath(org, "/workspaces");
  const res = await call(deps, scope, { path });
  const workspaces = expectArray<WorkspaceSummary>((res.body as Partial<WorkspacesResponse> | null)?.workspaces, `GET ${path}`);
  return new Map(workspaces.map((workspace) => [workspace.id, workspace.slug]));
}

async function orgKnowledgeList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, {}, "org knowledge list option");
  const { scope, org } = await readScope(deps, context);
  const path = orgKnowledgePath(org);
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as LibraryBody;
  const documents = expectArray<LibraryDocumentRow>(body.documents, `GET ${path}`);
  // Ids are what the grant route wrote; slugs are what a person passes and reads,
  // so they are resolved here rather than printed raw.
  const slugs = documents.length === 0 ? new Map<string, string>() : await workspaceSlugsById(deps, scope, org);
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "FILENAME", "STATUS", "CHUNKS", "BYTES", "WORKSPACES"],
      rows: documents.map((doc) => [
        text(doc.id),
        text(doc.filename),
        statusCell(doc),
        text(doc.chunkCount),
        text(doc.sizeBytes),
        (doc.workspaceIds ?? []).map((id) => slugs.get(id) ?? id).join(", ") || "-",
      ]),
      emptyMessage: `Organisation ${org} has no shared knowledge documents.`,
    })}\n`,
  );
  reportEmbedder(deps, body);
}

async function workspaceKnowledgeList(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const workspace = requirePositional(args, "workspace knowledge list", "workspace slug");
  assertKnown(args.slice(1), {}, "workspace knowledge list option");
  const { scope, org } = await readScope(deps, context);
  const path = workspaceKnowledgePath(org, workspace);
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as LibraryBody;
  const documents = expectArray<LibraryDocumentRow>(body.documents, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "FILENAME", "STATUS", "CHUNKS", "BYTES", "UPDATED"],
      rows: documents.map((doc) => [
        text(doc.id),
        text(doc.filename),
        statusCell(doc),
        text(doc.chunkCount),
        text(doc.sizeBytes),
        text(doc.updatedAt),
      ]),
      // The workspace's OWN library, not what the organisation lends it: those
      // are two collections and `org knowledge list` shows the grants.
      emptyMessage: `Workspace ${workspace} has no library documents of its own.`,
    })}\n`,
  );
  reportEmbedder(deps, body);
}

/** The multipart part the engine's `FileInterceptor` reads, and its one field name. */
async function uploadBody(deps: ServiceDependencies, file: string, filename: string): Promise<FormData> {
  const bytes = await deps.readBytes(file);
  if (bytes.byteLength === 0) throw new ConfigError(`${file} is empty.`);
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  return form;
}

function uploadTarget(options: readonly string[], action: string): { file: string; filename: string } {
  const file = takeValue(options, "--file");
  if (file === undefined) throw new ConfigError(`polyant-cli ${action} needs --file <path>.`);
  if (file === "-") {
    throw new ConfigError(`polyant-cli ${action} needs a real path: a multipart upload carries a filename, and stdin has none.`);
  }
  const filename = takeValue(options, "--filename") ?? file.split("/").pop();
  if (filename === undefined || filename.length === 0) throw new ConfigError(`polyant-cli ${action} could not derive a filename; pass --filename <name>.`);
  return { file, filename };
}

const INGEST_NOTE = "The engine extracts, chunks and embeds it afterwards: the document is not searchable until its status reaches ready.";

async function orgKnowledgeAdd(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  assertKnown(args, { value: ["--file", "--filename", "--confirm"] }, "org knowledge add option");
  const { file, filename } = uploadTarget(args, "org knowledge add");
  const form = await uploadBody(deps, file, filename);
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Add ${filename} to ${org}'s shared library`,
    changes: [`Upload ${filename} from ${file}.`, "It reaches no workspace until it is granted one.", INGEST_NOTE],
  };
  if (!(await preflight(deps, scope, org, context, args, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: orgKnowledgePath(org, "/file"), formData: form });
  report(deps, context, res.raw, `Added ${filename} to ${org}'s shared library.`);
}

async function workspaceKnowledgeAdd(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const workspace = requirePositional(args, "workspace knowledge add", "workspace slug");
  const options = args.slice(1);
  assertKnown(options, { value: ["--file", "--filename", "--confirm"] }, "workspace knowledge add option");
  const { file, filename } = uploadTarget(options, "workspace knowledge add");
  const form = await uploadBody(deps, file, filename);
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Add ${filename} to workspace ${workspace}'s library`,
    changes: [`Upload ${filename} from ${file}.`, `Every agent in ${workspace} may switch it on; no other workspace can reach it.`, INGEST_NOTE],
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "POST", path: workspaceKnowledgePath(org, workspace, "/file"), formData: form });
  report(deps, context, res.raw, `Added ${filename} to ${workspace}'s library.`);
}

async function orgKnowledgeRemove(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const docId = requirePositional(args, "org knowledge remove", "document id");
  const options = args.slice(1);
  assertKnown(options, { value: ["--confirm"] }, "org knowledge remove option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Remove document ${docId} from ${org}'s shared library`,
    changes: [
      "Delete the document and its embeddings.",
      "Every agent that had switched it on loses it — the grants go with the document.",
    ],
    destructive: { confirm: docId },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: orgKnowledgePath(org, `/${encodeURIComponent(docId)}`) });
  report(deps, context, res.raw, `Removed ${docId} from ${org}'s shared library.`);
}

async function workspaceKnowledgeRemove(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const workspace = requirePositional(args, "workspace knowledge remove", "workspace slug");
  const docId = requirePositional(args.slice(1), "workspace knowledge remove", "document id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, "workspace knowledge remove option");
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `Remove document ${docId} from workspace ${workspace}`,
    changes: ["Delete the document and its embeddings.", `Every agent in ${workspace} that had switched it on loses it.`],
    destructive: { confirm: docId },
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const res = await call(deps, scope, { method: "DELETE", path: workspaceKnowledgePath(org, workspace, `/${encodeURIComponent(docId)}`) });
  report(deps, context, res.raw, `Removed ${docId} from ${workspace}.`);
}

async function orgKnowledgeGrant(
  args: string[],
  context: CommandContext | undefined,
  deps: ServiceDependencies,
  granted: boolean,
): Promise<void> {
  const action = granted ? "org knowledge grant" : "org knowledge revoke";
  const docId = requirePositional(args, action, "document id");
  const workspace = requirePositional(args.slice(1), action, "workspace slug");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, `${action} option`);
  const { scope, org } = await readScope(deps, context);

  const plan = {
    title: `${granted ? "Grant" : "Revoke"} document ${docId} ${granted ? "to" : "from"} workspace ${workspace}`,
    changes: granted
      ? [`Agents in ${workspace} may switch this document on. It is not on any of them yet.`]
      : [
          `Agents in ${workspace} can no longer reach it.`,
          // The engine reports these rather than clearing them, so an operator
          // sees what broke instead of an agent quietly losing a source.
          "One that had it switched on keeps the switch, and the document is reported as revoked until someone takes it off.",
        ],
    ...(granted ? {} : { destructive: { confirm: docId } }),
  };
  if (!(await preflight(deps, scope, org, context, options, plan))) return;

  const path = orgKnowledgePath(org, `/${encodeURIComponent(docId)}/workspaces/${encodeURIComponent(workspace)}`);
  const res = await call(deps, scope, { method: granted ? "PUT" : "DELETE", path });
  report(deps, context, res.raw, `${granted ? "Granted" : "Revoked"} ${docId} ${granted ? "to" : "from"} ${workspace}.`);
}

// --- the agent's own switch ---------------------------------------------------

interface SharedDocumentRow {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  chunkCount: number;
  tier: string;
  enabled: boolean;
  /**
   * Since 1.2.0, whether the library declares an embedder at all. A turn embeds
   * its query with the ORGANISATION's embedder for shared documents, so the
   * agent's own embedder no longer has to match.
   */
  usable: boolean;
}

async function sharedKnowledgeShow(args: string[], context: CommandContext | undefined, deps: ServiceDependencies): Promise<void> {
  const slug = requireSlug(args, "shared-knowledge show");
  assertKnown(args.slice(1), {}, "agent shared-knowledge show option");
  const scope = await scopeFor(deps, context, "read");
  const path = agentPath(slug, "/shared-knowledge");
  const res = await call(deps, scope, { path });
  if (wantsJson(context)) return writeRawResponse(deps.io, res.raw);

  const body = (res.body ?? {}) as {
    documents?: unknown;
    revoked?: unknown;
    embedder?: { provider?: unknown; dimensions?: unknown } | null;
    agentEmbedder?: { provider?: unknown; dimensions?: unknown };
    /** Whether the organisation's embedder has a credential to embed the query with. Absent before 1.2.0. */
    embedderCredentialReady?: boolean;
  };
  const documents = expectArray<SharedDocumentRow>(body.documents, `GET ${path}`);
  deps.io.stdout(
    `${renderTable({
      headers: ["ID", "FILENAME", "TIER", "STATUS", "ON", "USABLE"],
      rows: documents.map((doc) => [
        text(doc.id),
        text(doc.filename),
        text(doc.tier),
        text(doc.status),
        doc.enabled ? "yes" : "no",
        doc.usable ? "yes" : "no",
      ]),
      emptyMessage: `No shared documents reach ${slug}. Grant its workspace one first.`,
    })}\n`,
  );

  const revoked = Array.isArray(body.revoked) ? (body.revoked as { documentId: string; filename: string }[]) : [];
  if (revoked.length > 0) {
    // Switched on, no longer reachable. The engine reports these deliberately,
    // and dropping them here would turn a loss the operator can fix into silence.
    deps.io.stdout(
      `\n${renderTable({
        headers: ["REVOKED DOCUMENT", "FILENAME"],
        rows: revoked.map((row) => [text(row.documentId), text(row.filename)]),
      })}\n`,
    );
  }
  writePrettyResource(deps.io, [
    { label: "library embedder", value: body.embedder == null ? "(none declared)" : `${text(body.embedder.provider)} (${text(body.embedder.dimensions)})` },
    {
      label: "library credential",
      value:
        body.embedderCredentialReady === undefined
          ? "-"
          : body.embedderCredentialReady
            ? "ready"
            : "MISSING — the query cannot be embedded, so no shared document is retrieved",
    },
    // The agent's own embedder indexes its own knowledge only; shared documents
    // are searched with the organisation's.
    { label: "agent embedder", value: `${text(body.agentEmbedder?.provider)} (${text(body.agentEmbedder?.dimensions)}) — own knowledge only` },
  ]);
}

async function sharedKnowledgeSet(
  args: string[],
  context: CommandContext | undefined,
  deps: ServiceDependencies,
  enable: boolean,
): Promise<void> {
  const action = enable ? "shared-knowledge enable" : "shared-knowledge disable";
  const slug = requireSlug(args, action);
  const docId = requireSecond(args, action, "document id");
  const options = args.slice(2);
  assertKnown(options, { value: ["--confirm"] }, `agent ${action} option`);

  const scope = await scopeFor(deps, context);
  const plan = {
    title: `${enable ? "Switch on" : "Switch off"} shared document ${docId} for ${slug}`,
    changes: enable
      ? [`${slug} starts retrieving from it. Nothing is copied: the document stays in the library.`]
      : [`${slug} stops retrieving from it. The document itself is untouched, and other agents keep it.`],
  };
  if (!(await agentPreflight(deps, scope, context, options, plan))) return;

  const res = await call(deps, scope, {
    method: enable ? "PUT" : "DELETE",
    path: agentPath(slug, `/shared-knowledge/${encodeURIComponent(docId)}`),
  });
  reportWrite(deps, context, res, `${enable ? "Switched on" : "Switched off"} ${docId} for ${slug}.`);
}

const LIBRARY_NOTE =
  "A shared document reaches a turn only when all three tiers agree: it is in a\nlibrary, the workspace is granted it, and the agent has switched it on.";

/** The `org knowledge` and `workspace knowledge` subtrees. */
export const KNOWLEDGE_FAMILY_EXTRAS: Record<string, Record<string, Node>> = {
  org: {
    knowledge: {
      list: {
        summary: "list the organisation's shared knowledge documents",
        usage: `Usage: polyant-cli org knowledge list

The WORKSPACES column is which workspaces the document is granted to, resolved
back to slugs. The library's embedder is printed on stderr: an agent configured
with a different one sees the documents and cannot use them. ${LIBRARY_NOTE}
${ORG_NOTE}`,
        action: orgKnowledgeList,
      },
      add: {
        summary: "upload a document into the organisation's library",
        usage: `Usage: polyant-cli org knowledge add --file <path> [--filename <name>]

A real path, not "-": this upload is multipart and a part carries a filename,
which stdin has none of. The document reaches no workspace until it is granted
one. ${ORG_NOTE}`,
        action: orgKnowledgeAdd,
        mutates: true,
      },
      remove: {
        summary: "delete one document from the organisation's library",
        usage: `Usage: polyant-cli org knowledge remove <docId> --yes --confirm <docId>

The grants go with the document, so every agent that had switched it on loses
it. ${ORG_NOTE}`,
        action: orgKnowledgeRemove,
        mutates: true,
      },
      grant: {
        summary: "let one workspace draw on a shared document",
        usage: `Usage: polyant-cli org knowledge grant <docId> <workspaceSlug>

The grant makes the document REACHABLE, not active: each agent still switches it
on with \`agent shared-knowledge enable\`. ${LIBRARY_NOTE} ${ORG_NOTE}`,
        action: (args, context, deps) => orgKnowledgeGrant(args, context, deps, true),
        mutates: true,
      },
      revoke: {
        summary: "stop one workspace drawing on a shared document",
        usage: `Usage: polyant-cli org knowledge revoke <docId> <workspaceSlug> --yes --confirm <docId>

An agent that had it switched on keeps the switch and is reported as having lost
the document, rather than silently losing a source. ${ORG_NOTE}`,
        action: (args, context, deps) => orgKnowledgeGrant(args, context, deps, false),
        mutates: true,
      },
    },
  },
  workspace: {
    knowledge: {
      list: {
        summary: "list one workspace's own library documents",
        usage: `Usage: polyant-cli workspace knowledge list <workspaceSlug>

The workspace's OWN documents. What the organisation lends it is a separate
collection — see \`org knowledge list\`. ${ORG_NOTE}`,
        action: workspaceKnowledgeList,
      },
      add: {
        summary: "upload a document into one workspace's library",
        usage: `Usage: polyant-cli workspace knowledge add <workspaceSlug> --file <path> [--filename <name>]

Every agent in that workspace may switch it on, and no other workspace can reach
it — a workspace document is never granted onward. ${ORG_NOTE}`,
        action: workspaceKnowledgeAdd,
        mutates: true,
      },
      remove: {
        summary: "delete one document from a workspace's library",
        usage: `Usage: polyant-cli workspace knowledge remove <workspaceSlug> <docId> --yes --confirm <docId>\n\n${ORG_NOTE}`,
        action: workspaceKnowledgeRemove,
        mutates: true,
      },
    },
  },
};

/** The `agent shared-knowledge` subtree. */
export const agentSharedKnowledgeFamily: Record<string, Node> = {
  show: {
    summary: "list the shared documents this agent can reach, and which are on",
    usage: `Usage: polyant-cli agent shared-knowledge show <slug>

Every document the agent's workspace is granted, whether the agent has switched
it on, and whether it is USABLE. Since engine 1.2.0 a turn embeds its query with
the organisation's embedder to search shared documents, so the agent's own
embedder does not have to match: a document is unusable only while the library
declares no embedder, and none is retrieved while the organisation's embedder
has no credential ("library credential" below).

A document switched on and later withdrawn is reported separately, under
REVOKED: it is a loss to act on, not a row to drop. ${LIBRARY_NOTE}`,
    action: sharedKnowledgeShow,
  },
  enable: {
    summary: "switch one shared document on for this agent",
    usage: `Usage: polyant-cli agent shared-knowledge enable <slug> <docId>

Configuration, not a copy: the document stays in the library and the agent
retrieves from it. Refused for a document the agent's workspace cannot reach.`,
    action: (args, context, deps) => sharedKnowledgeSet(args, context, deps, true),
    mutates: true,
  },
  disable: {
    summary: "switch one shared document off for this agent",
    usage: `Usage: polyant-cli agent shared-knowledge disable <slug> <docId>

Works for a withdrawn document too, which is the only way to clear a reported
loss.`,
    action: (args, context, deps) => sharedKnowledgeSet(args, context, deps, false),
    mutates: true,
  },
};
