import { rawRequest, sleep, type RawResponse } from "./http";
import { CliError, ExitCode } from "./errors";
import { log } from "./logger";
import { userAgent } from "./version";
import { getValidAccessToken, doRefresh } from "./tokens";
import type { RuntimeContext } from "./context";
import type { Envelope } from "./types";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface ApiRequestOptions {
  method: HttpMethod;
  /** Relative path (e.g. "shipment/quotations") or absolute (starts with http). */
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Send Authorization header (default true). */
  auth?: boolean;
  /** Prefix with /open_api/{api_version}/ (default true). */
  versioned?: boolean;
  retries?: number;
  /** Use this bearer token instead of the stored/profile token (per-request auth,
   *  e.g. the HTTP MCP server serving multiple users). Disables auto-refresh. */
  accessToken?: string;
}

/** Resolve a request path into a full URL, applying the version prefix. */
export function buildUrl(
  ctx: RuntimeContext,
  path: string,
  versioned: boolean,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  let urlStr: string;
  let p = path.trim();
  if (/^https?:\/\//i.test(p)) {
    urlStr = p;
  } else {
    p = p.replace(/^\/+/, "");
    if (versioned && !p.startsWith("open_api/")) {
      p = `open_api/${ctx.apiVersion}/${p}`;
    }
    urlStr = `${ctx.baseUrl}/${p}`;
  }
  const u = new URL(urlStr);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

function truncate(s: string, max = 2000): string {
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} bytes)` : s;
}

async function callWithBackoff(fn: () => Promise<RawResponse>, retries: number): Promise<RawResponse> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= retries) {
    try {
      const res = await fn();
      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers["retry-after"]);
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000);
        log.warn(`rate limited (429) — retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
        await sleep(delay);
        attempt++;
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) break;
      const delay = Math.min(500 * 2 ** attempt, 8000);
      log.warn(`request failed (${(e as Error).message}) — retrying in ${delay}ms`);
      await sleep(delay);
      attempt++;
    }
  }
  throw new CliError(`Network error: ${(lastErr as Error)?.message ?? "unknown"}`, ExitCode.NETWORK, lastErr);
}

function parseEnvelope(res: RawResponse): Envelope {
  let body: any;
  try {
    body = res.body ? JSON.parse(res.body) : {};
  } catch {
    body = { message: res.body };
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    if (typeof body.status_code !== "number") body.status_code = res.status;
    body._http_status = res.status;
    return body as Envelope;
  }
  // Array or scalar body → wrap into an envelope.
  return { status_code: res.status, _http_status: res.status, data: body } as Envelope;
}

/**
 * Perform an authenticated EasyParcel API request and return the parsed
 * response envelope. Handles version prefixing, bearer auth, a single
 * transparent token-refresh on 401, and 429/network backoff.
 *
 * Note: this does NOT throw on API-level errors (4xx envelopes / per-item
 * batch errors). It returns the envelope so callers can surface the full,
 * structured error to the user/agent; exit codes are decided by the runner.
 */
export async function apiRequest<T = unknown>(
  ctx: RuntimeContext,
  opts: ApiRequestOptions,
): Promise<Envelope<T>> {
  const versioned = opts.versioned !== false;
  const auth = opts.auth !== false;
  const url = buildUrl(ctx, opts.path, versioned, opts.query);
  const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

  let token = auth ? (opts.accessToken ?? (await getValidAccessToken(ctx))) : undefined;

  const doCall = (tok?: string): Promise<RawResponse> => {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": userAgent() };
    if (bodyStr !== undefined) headers["Content-Type"] = "application/json";
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
    log.debug(`${opts.method} ${url}${bodyStr ? ` body=${truncate(bodyStr)}` : ""}`);
    return rawRequest(url, { method: opts.method, headers, body: bodyStr, timeoutMs: ctx.timeoutMs });
  };

  let res = await callWithBackoff(() => doCall(token), opts.retries ?? ctx.retries);

  if (res.status === 401 && auth && !opts.accessToken) {
    const refreshed = await doRefresh(ctx);
    if (refreshed) {
      token = refreshed;
      res = await callWithBackoff(() => doCall(token), opts.retries ?? ctx.retries);
    }
  }

  const env = parseEnvelope(res) as Envelope<T>;
  if (env.request_id) log.debug(`request_id=${env.request_id}`);
  return env;
}
