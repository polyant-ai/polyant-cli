// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { ConfigError, ExitCode, RemoteError, type ExitCodeValue } from "../exit.js";
import type { ResolvedTarget } from "../config.js";

/**
 * Management API key header. The guard evaluates it before the session cookie
 * and before ALB-OIDC, so presenting it commits to the service-principal path.
 */
export const KEY_HEADER = "X-Polyant-Key";

/**
 * Selects the workspace a management route operates in. A service principal is
 * org-scoped, so without it the engine picks its own default workspace and the
 * caller silently reads or writes the wrong one.
 *
 * The slug, not an id: the engine deliberately keeps workspace ids off the wire,
 * so the slug is the only external identifier. Sending an id here would be a
 * second, unauthoritative name for the same thing.
 */
export const WORKSPACE_HEADER = "x-workspace-slug";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Routes that live outside /api, which callers get wrong systematically. */
const TOP_LEVEL_PREFIXES = "/health, /v1, /memories, /channels/http, /webhooks, /oauth";

export interface RequestOptions {
  method?: string;
  /** Must start with "/". Not every route sits under /api. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /**
   * Request body forwarded byte-for-byte. `api` uses it so a passthrough does
   * not alter the caller's own JSON: parsing and re-serialising loses integer
   * precision, turns `1.0` into `1`, and collapses duplicate keys — on the way
   * in exactly as it would on the way out.
   */
  rawBody?: string;
  /** Request deadline. `0` disables it, which only a long-lived stream needs. */
  timeoutMs?: number;
  /** Runtime routes take a per-instance key as a Bearer token instead of the management key. */
  bearer?: string;
  /** Slug of the active workspace, for management routes that resolve one. */
  workspaceSlug?: string;
}

export interface ApiResponse {
  status: number;
  /** The response text exactly as received. `api` prints this, so a passthrough stays faithful. */
  raw: string;
  /** Parsed JSON when the body was JSON, the raw text otherwise, `null` when empty. */
  body: unknown;
}

/**
 * 429 is transient and retryable, so it is a remote failure, not a
 * configuration one. Every other 4xx means the caller asked wrongly.
 */
export function statusToExitCode(status: number): ExitCodeValue {
  if (status === 429 || status >= 500) return ExitCode.Remote;
  return ExitCode.Config;
}

/**
 * The engine's error envelope is not uniform: 400/401/403 carry
 * `{ statusCode, message, error }`, a 429 has no `error` key, and an unhandled
 * 500 is `{ statusCode, message }`. Zod failures arrive as one string joined
 * with "; ". So: read `message`, never `error`.
 */
export function extractMessage(status: number, body: unknown): string {
  if (typeof body === "string" && body.length > 0) return body;
  if (body !== null && typeof body === "object" && "message" in body) {
    const message = (body as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
    if (Array.isArray(message)) return message.join("; ");
  }
  return `HTTP ${status}`;
}

async function readBody(res: Response): Promise<{ raw: string; body: unknown }> {
  const raw = await res.text();
  if (raw.length === 0) return { raw, body: null };
  try {
    return { raw, body: JSON.parse(raw) };
  } catch {
    return { raw, body: raw };
  }
}

function buildHeaders(target: ResolvedTarget, opts: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = opts.bearer
    ? { Authorization: `Bearer ${opts.bearer}` }
    : { [KEY_HEADER]: target.key };
  if (opts.body !== undefined || opts.rawBody !== undefined) headers["Content-Type"] = "application/json";
  if (opts.workspaceSlug !== undefined) headers[WORKSPACE_HEADER] = opts.workspaceSlug;
  return headers;
}

function buildUrl(target: ResolvedTarget, opts: RequestOptions): URL {
  if (!opts.path.startsWith("/")) {
    throw new ConfigError(
      `Path must start with "/" (got "${opts.path}"). Not every route is under /api: ${TOP_LEVEL_PREFIXES}.`,
    );
  }
  const url = new URL(target.baseUrl + opts.path);
  for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
  return url;
}

function bodyInit(opts: RequestOptions): { body?: string } {
  if (opts.rawBody !== undefined) return { body: opts.rawBody };
  return opts.body === undefined ? {} : { body: JSON.stringify(opts.body) };
}

async function send(
  url: URL,
  method: string,
  target: ResolvedTarget,
  opts: RequestOptions,
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: buildHeaders(target, opts),
      ...bodyInit(opts),
      // A follow stream is meant to stay open; a deadline would abort it mid-run
      // and read as a remote failure. Such a caller passes 0 and ends the stream
      // itself (or the operator interrupts it).
      ...(opts.timeoutMs === 0 ? {} : { signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) }),
      // Never follow a redirect. The fetch spec strips `Authorization` across
      // origins but NOT a custom header, so following one would re-send
      // X-Polyant-Key to whatever host the Location names. `request` turns the
      // 3xx into a ConfigError instead.
      redirect: "manual",
    });
  } catch (error) {
    // Unreachable host, DNS failure or timeout — all transient, hence Remote.
    const reason = error instanceof Error ? error.message : String(error);
    throw new RemoteError(`${method} ${url.pathname} failed: ${reason}`, ExitCode.Remote);
  }
}

/**
 * The part every caller shares: identical headers, timeout, redirect refusal
 * and status mapping. It stops short of reading the body, so a streaming caller
 * can keep `Response.body` readable.
 */
async function dispatch(target: ResolvedTarget, opts: RequestOptions): Promise<{ res: Response; url: URL; method: string }> {
  const url = buildUrl(target, opts);
  const method = opts.method ?? "GET";
  const res = await send(url, method, target, opts);

  // A 3xx reaches here because `send` asked for `redirect: "manual"`. The
  // realistic trigger is a login proxy in front of the engine: following it
  // would hand the management key to the identity provider and return its login
  // page as if it were the API's answer, with exit 0. Fail closed instead.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    throw new ConfigError(
      `${method} ${url.pathname} was redirected (${res.status}${location ? ` to ${location}` : ""}). ` +
        `Refusing to resend the management key to another host — is this target behind a login proxy?`,
    );
  }
  return { res, url, method };
}

export async function request(target: ResolvedTarget, opts: RequestOptions): Promise<ApiResponse> {
  const { res } = await dispatch(target, opts);

  const { raw, body } = await readBody(res);
  if (!res.ok) {
    throw new RemoteError(extractMessage(res.status, body), statusToExitCode(res.status), res.status);
  }
  return { status: res.status, raw, body };
}

/** One decoded `data:` payload of a Server-Sent Events stream. */
export interface StreamEvent {
  data: string;
}

export interface StreamResponse {
  status: number;
  /** Yields one entry per `data:` event; comment lines (`: ping`) are dropped. */
  events: AsyncIterable<StreamEvent>;
}

/**
 * Splits an SSE byte stream into events. Comment lines carry the heartbeat and
 * the initial `: connected` marker, so they are consumed but never surfaced.
 */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let boundary = buffered.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) yield { data };
      boundary = buffered.indexOf("\n\n");
    }
  }
}

/**
 * A streaming read. An error status is still read and mapped exactly as
 * `request` does — the engine answers a rejected subscription with JSON, not
 * with an event stream, and reporting it as an empty stream would look like
 * silence rather than a refusal.
 */
export async function requestStream(target: ResolvedTarget, opts: RequestOptions): Promise<StreamResponse> {
  const { res } = await dispatch(target, opts);

  if (!res.ok) {
    const { body } = await readBody(res);
    throw new RemoteError(extractMessage(res.status, body), statusToExitCode(res.status), res.status);
  }
  if (res.body === null) throw new RemoteError(`${opts.path} returned no stream body.`, ExitCode.Remote);
  return { status: res.status, events: parseSse(res.body) };
}
