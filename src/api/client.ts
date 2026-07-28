// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { ConfigError, ExitCode, RemoteError, type ExitCodeValue } from "../exit.js";
import type { ResolvedTarget } from "../config.js";

/**
 * Management API key header. The guard evaluates it before the session cookie
 * and before ALB-OIDC, so presenting it commits to the service-principal path.
 */
export const KEY_HEADER = "X-Polyant-Key";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Routes that live outside /api, which callers get wrong systematically. */
const TOP_LEVEL_PREFIXES = "/health, /v1, /memories, /channels/http, /webhooks, /oauth";

export interface RequestOptions {
  method?: string;
  /** Must start with "/". Not every route sits under /api. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /** Runtime routes take a per-instance key as a Bearer token instead of the management key. */
  bearer?: string;
}

export interface ApiResponse {
  status: number;
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

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function buildHeaders(target: ResolvedTarget, opts: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = opts.bearer
    ? { Authorization: `Bearer ${opts.bearer}` }
    : { [KEY_HEADER]: target.key };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
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
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // Unreachable host, DNS failure or timeout — all transient, hence Remote.
    const reason = error instanceof Error ? error.message : String(error);
    throw new RemoteError(`${method} ${url.pathname} failed: ${reason}`, ExitCode.Remote);
  }
}

export async function request(target: ResolvedTarget, opts: RequestOptions): Promise<ApiResponse> {
  const url = buildUrl(target, opts);
  const method = opts.method ?? "GET";
  const res = await send(url, method, target, opts);
  const body = await readBody(res);
  if (!res.ok) {
    throw new RemoteError(extractMessage(res.status, body), statusToExitCode(res.status), res.status);
  }
  return { status: res.status, body };
}
