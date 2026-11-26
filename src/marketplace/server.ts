// SPDX-License-Identifier: Apache-2.0
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative, resolve, sep } from "node:path";

/**
 * Serves `<outDir>/v1/*` read-only over HTTP, and nothing else.
 *
 * The engine reads three kinds of path from a marketplace: the catalogue, its
 * signature, and artifacts. An unsigned marketplace has no signature, and the
 * engine does not ask for one, so `/v1/catalog.sig.json` simply does not exist
 * here and answers 404 like any other absent file — as do the optional MCP and
 * model catalogues, which the engine reads as "not published" on a 404.
 *
 * The server is reached through a public tunnel, so it trusts nothing in the
 * request path: it is decoded once, refused if it holds a dot segment, a
 * backslash or a NUL, and the file it resolves to must still be under `v1/`.
 */

export interface MarketplaceServerOptions {
  readonly outDir: string;
  readonly host: string;
  readonly port: number;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  readonly token?: string;
  /** One line per request, for the operator. */
  readonly log?: (line: string) => void;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = { ".json": "application/json", ".gz": "application/gzip" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time over equal-length digests, so the comparison leaks neither length nor prefix. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  return match !== null && timingSafeEqual(digest(match[1]), digest(token));
}

/** The file a request path names under `<outDir>/v1`, or undefined when it may not name one. */
export function resolveServedFile(outDir: string, rawPath: string): string | undefined {
  const pathname = rawPath.split("?")[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (!decoded.startsWith("/v1/") || decoded.includes("\\") || decoded.includes("\0") || decoded.includes("//")) return undefined;
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  const root = resolve(outDir, "v1");
  const file = resolve(outDir, `.${decoded}`);
  const fromRoot = relative(root, file);
  if (fromRoot === "" || fromRoot.startsWith("..") || fromRoot.startsWith(sep)) return undefined;
  return join(root, fromRoot);
}

function send(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(`${body}\n`);
}

async function handle(options: MarketplaceServerOptions, request: IncomingMessage, response: ServerResponse): Promise<number> {
  if (options.token !== undefined && !bearerMatches(request.headers.authorization, options.token)) {
    send(response, 401, "unauthorized", { "www-authenticate": "Bearer" });
    return 401;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "method not allowed", { allow: "GET, HEAD" });
    return 405;
  }
  const file = resolveServedFile(options.outDir, request.url ?? "/");
  if (file === undefined) {
    send(response, 404, "not found");
    return 404;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    send(response, 404, "not found");
    return 404;
  }
  const extension = file.slice(file.lastIndexOf("."));
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    "content-length": String(bytes.length),
    "cache-control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
  return 200;
}

export function startMarketplaceServer(options: MarketplaceServerOptions): Promise<RunningServer> {
  const server: Server = createServer((request, response) => {
    handle(options, request, response).then(
      (status) => options.log?.(`${request.method ?? "?"} ${request.url ?? "?"} ${status}`),
      () => {
        if (!response.headersSent) send(response, 500, "internal error");
        else response.destroy();
      },
    );
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      const { port } = server.address() as AddressInfo;
      resolvePromise({
        url: `http://${options.host}:${port}`,
        port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
