import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { rawRequest, sleep } from "./http";
import { CliError, ExitCode } from "./errors";
import { log } from "./logger";
import { userAgent } from "./version";
import { DEFAULT_CALLBACK_PORT } from "./config";
import type { TokenResponse } from "./types";

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): PkcePair {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function randomState(): string {
  return base64url(crypto.randomBytes(16));
}

// ---------------------------------------------------------------------------
// Authorization URL + token exchange
// ---------------------------------------------------------------------------

export interface AuthUrlParams {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
}

export function buildAuthUrl(p: AuthUrlParams): string {
  const u = new URL("/oauth/login", p.baseUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (p.scope) u.searchParams.set("scope", p.scope);
  return u.toString();
}

/** Apply RFC 6749 client authentication: HTTP Basic when a secret is present, else client_id in the body. */
function applyClientAuth(
  headers: Record<string, string>,
  body: URLSearchParams,
  clientId?: string,
  clientSecret?: string,
): void {
  if (clientId && clientSecret) {
    headers["Authorization"] = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  } else if (clientId) {
    body.set("client_id", clientId);
  }
}

interface RawTokenResult {
  status: number;
  json: any;
  raw: string;
}

/**
 * Low-level POST to an OAuth endpoint ({base}{path}) with form-encoded body.
 * Returns the parsed body and status WITHOUT throwing on 4xx — callers that need
 * to branch on the standard OAuth error codes (device-grant polling, revoke) use
 * this directly; tokenRequest() wraps it with the throw-on-error behaviour.
 */
async function rawTokenPost(
  baseUrl: string,
  path: string,
  body: URLSearchParams,
  clientId?: string,
  clientSecret?: string,
): Promise<RawTokenResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": userAgent(),
  };
  applyClientAuth(headers, body, clientId, clientSecret);
  const url = new URL(path, baseUrl).toString();
  const res = await rawRequest(url, { method: "POST", headers, body: body.toString() });
  let json: any;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = { raw: res.body };
  }
  return { status: res.status, json, raw: res.body };
}

/** Pull the token object out of a response that may be bare or { data: {...} }-wrapped. */
function extractToken(json: any): TokenResponse | null {
  return json?.access_token ? json : json?.data?.access_token ? json.data : null;
}

async function tokenRequest(
  baseUrl: string,
  body: URLSearchParams,
  clientId?: string,
  clientSecret?: string,
): Promise<TokenResponse> {
  const { status, json, raw } = await rawTokenPost(baseUrl, "/oauth/token", body, clientId, clientSecret);
  // Some EasyParcel responses wrap the payload in { status_code, message, data }.
  const token = extractToken(json);
  if (status >= 400 || json?.error || !token) {
    const detail = json?.error_description || json?.message || json?.error;
    const snippet = detail ? "" : ` — response body: ${(raw || "(empty)").slice(0, 400).replace(/\s+/g, " ")}`;
    const msg = detail || `unexpected token response (HTTP ${status})`;
    throw new CliError(`OAuth token request failed: ${msg}${snippet}`, ExitCode.AUTH, json);
  }
  return token;
}

export interface CodeExchangeParams {
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  state?: string;
}

export function exchangeCode(p: CodeExchangeParams): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    code_verifier: p.codeVerifier,
  });
  if (p.state) body.set("state", p.state);
  return tokenRequest(p.baseUrl, body, p.clientId, p.clientSecret);
}

export function refreshToken(p: {
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.refreshToken });
  return tokenRequest(p.baseUrl, body, p.clientId, p.clientSecret);
}

export function clientCredentials(p: {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (p.scope) body.set("scope", p.scope);
  return tokenRequest(p.baseUrl, body, p.clientId, p.clientSecret);
}

// ---------------------------------------------------------------------------
// Device authorization grant (RFC 8628)
// ---------------------------------------------------------------------------

export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

/** Start a device-code flow: POST {base}/oauth/device_authorization (RFC 8628 §3.1–3.2). */
export async function requestDeviceAuthorization(p: {
  baseUrl: string;
  clientId: string;
  scope?: string;
}): Promise<DeviceAuthorization> {
  const body = new URLSearchParams({ client_id: p.clientId });
  if (p.scope) body.set("scope", p.scope);
  const { status, json } = await rawTokenPost(p.baseUrl, "/oauth/device_authorization", body, p.clientId);
  const d = json?.device_code ? json : json?.data?.device_code ? json.data : null;
  if (status >= 400 || json?.error || !d) {
    const msg = json?.error_description || json?.message || json?.error || `device authorization failed (HTTP ${status})`;
    throw new CliError(`Device authorization request failed: ${msg}`, ExitCode.AUTH, json);
  }
  const verification_uri: string = d.verification_uri || d.verification_url;
  if (!d.device_code || !d.user_code || !verification_uri) {
    throw new CliError("Device authorization response was missing device_code / user_code / verification_uri.", ExitCode.AUTH, json);
  }
  return {
    device_code: d.device_code,
    user_code: d.user_code,
    verification_uri,
    verification_uri_complete: d.verification_uri_complete || d.verification_url_complete,
    expires_in: Number(d.expires_in) > 0 ? Number(d.expires_in) : 600,
    interval: Number(d.interval) > 0 ? Number(d.interval) : 5,
  };
}

export type DevicePoll =
  | { status: "approved"; token: TokenResponse }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; error: string; description?: string };

/**
 * Pure interpreter for a device-grant token-endpoint response (RFC 8628 §3.5).
 * Kept side-effect free so the polling state machine is unit-testable.
 */
export function interpretDeviceToken(httpStatus: number, json: any): DevicePoll {
  const token = extractToken(json);
  if (token && httpStatus < 400 && !json?.error) return { status: "approved", token };
  const error = json?.error || json?.data?.error;
  switch (error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return {
        status: "error",
        error: error || `token endpoint error (HTTP ${httpStatus})`,
        description: json?.error_description || json?.message,
      };
  }
}

export interface DevicePollOptions {
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
  /** Test seam: post the poll body and return {status,json}. Defaults to the real token endpoint. */
  poster?: (body: URLSearchParams) => Promise<{ status: number; json: any }>;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: injectable clock for the expiry deadline. */
  now?: () => number;
  /** Called after each pending/slow_down tick with the current interval (seconds). */
  onTick?: (intervalSec: number) => void;
}

/**
 * Poll the token endpoint until the user approves the device code, honouring the
 * server `interval`, backing off by 5s on `slow_down`, and failing on
 * `expired_token` / `access_denied` / the overall expiry (RFC 8628 §3.4–3.5).
 */
export async function pollForDeviceToken(opts: DevicePollOptions): Promise<TokenResponse> {
  const sleepFn = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  const poster =
    opts.poster ??
    (async (body: URLSearchParams) => {
      const { status, json } = await rawTokenPost(opts.baseUrl, "/oauth/token", body, opts.clientId, opts.clientSecret);
      return { status, json };
    });

  let interval = Math.max(1, opts.interval || 5);
  const deadline = now() + (opts.expiresIn > 0 ? opts.expiresIn : 600) * 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (now() >= deadline) {
      throw new CliError("Device code expired before authorization. Run `ep login --device` again.", ExitCode.AUTH);
    }
    await sleepFn(interval * 1000);
    const body = new URLSearchParams({ grant_type: DEVICE_GRANT_TYPE, device_code: opts.deviceCode });
    const { status, json } = await poster(body);
    const result = interpretDeviceToken(status, json);
    switch (result.status) {
      case "approved":
        return result.token;
      case "pending":
        opts.onTick?.(interval);
        continue;
      case "slow_down":
        interval += 5;
        opts.onTick?.(interval);
        continue;
      case "denied":
        throw new CliError("Authorization was denied on the device.", ExitCode.AUTH);
      case "expired":
        throw new CliError("Device code expired before authorization. Run `ep login --device` again.", ExitCode.AUTH);
      case "error":
        throw new CliError(`Device authorization failed: ${result.description || result.error}`, ExitCode.AUTH, json);
    }
  }
}

// ---------------------------------------------------------------------------
// Token revocation (RFC 7009)
// ---------------------------------------------------------------------------

/**
 * Best-effort token revocation: POST {base}/oauth/revoke (RFC 7009). Never throws —
 * returns false on any failure so logout can revoke-then-clear regardless.
 */
export async function revokeToken(p: {
  baseUrl: string;
  token: string;
  tokenTypeHint?: "refresh_token" | "access_token";
  clientId?: string;
  clientSecret?: string;
}): Promise<boolean> {
  const body = new URLSearchParams({ token: p.token });
  if (p.tokenTypeHint) body.set("token_type_hint", p.tokenTypeHint);
  try {
    const { status } = await rawTokenPost(p.baseUrl, "/oauth/revoke", body, p.clientId, p.clientSecret);
    // RFC 7009 §2.2: the AS responds 200 whether or not the token existed.
    return status < 400;
  } catch (e) {
    log.debug(`revoke request failed: ${(e as Error).message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Headless / no-browser detection (auto-select the device grant)
// ---------------------------------------------------------------------------

export interface HeadlessSignals {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
}

/**
 * True when we almost certainly cannot pop a browser on THIS machine, so the
 * device grant is the better default: an SSH session, a Linux/BSD box with no
 * X11/Wayland display, or no controlling terminal at all.
 */
export function detectHeadless(s: HeadlessSignals): boolean {
  if (s.env.SSH_CONNECTION || s.env.SSH_TTY || s.env.SSH_CLIENT) return true;
  const guiPlatform = s.platform === "win32" || s.platform === "darwin";
  if (!guiPlatform && !s.env.DISPLAY && !s.env.WAYLAND_DISPLAY) return true;
  if (!s.stdoutIsTTY && !s.stderrIsTTY) return true;
  return false;
}

export function currentHeadlessSignals(): HeadlessSignals {
  return {
    env: process.env,
    platform: process.platform,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  };
}

// ---------------------------------------------------------------------------
// Loopback callback server (for browser-based PKCE login)
// ---------------------------------------------------------------------------

export interface LoopbackServer {
  port: number;
  redirectUri: string;
  waitForCode(timeoutMs: number): Promise<{ code: string; state: string }>;
  close(): void;
}

function htmlPage(message: string, ok: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>EasyParcel CLI</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;height:100vh;
align-items:center;justify-content:center;margin:0}.card{text-align:center;padding:2rem 3rem;border-radius:12px;
background:#1e293b;box-shadow:0 10px 30px rgba(0,0,0,.4)}h1{color:${ok ? "#22c55e" : "#ef4444"};margin:0 0 .5rem}
p{color:#94a3b8}</style></head><body><div class="card"><h1>${ok ? "&#10003; Connected" : "&#10007; Failed"}</h1>
<p>${message}</p></div></body></html>`;
}

export function startLoopbackServer(opts: {
  state: string;
  /** Preferred port. Use 0 for an OS-assigned random free port (RFC 8252). */
  port: number;
  /** Fall back to this fixed port if binding `port` fails (e.g. the registered 8788). */
  fallbackPort?: number;
  callbackPath?: string;
}): Promise<LoopbackServer> {
  return new Promise((resolve, reject) => {
    const cbPath = opts.callbackPath ?? "/callback";
    let resolveCode!: (v: { code: string; state: string }) => void;
    let rejectCode!: (e: Error) => void;
    const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname !== cbPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const error = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage(`Authorization error: ${error}`, false));
        rejectCode(new CliError(`Authorization denied: ${error}`, ExitCode.AUTH));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage("No authorization code returned.", false));
        rejectCode(new CliError("No authorization code returned by the server", ExitCode.AUTH));
        return;
      }
      if (opts.state && state !== opts.state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage("State mismatch — request aborted.", false));
        rejectCode(new CliError("OAuth state mismatch (possible CSRF) — aborting", ExitCode.AUTH));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(htmlPage("Authorization complete. You can close this tab and return to your terminal.", true));
      resolveCode({ code, state: state ?? "" });
    });

    // Track open sockets so we can force-close them. Browsers hold the callback
    // connection open with keep-alive, which would otherwise prevent server.close()
    // from completing and leave the CLI hanging until Ctrl+C.
    const sockets = new Set<any>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

    let triedFallback = false;
    server.on("error", (e) => {
      // Random port (0) effectively never fails; a fixed --port can collide. Fall
      // back once to the registered 8788 before giving up.
      if (!triedFallback && opts.fallbackPort != null && opts.fallbackPort !== opts.port) {
        triedFallback = true;
        log.debug(`loopback bind on port ${opts.port} failed (${(e as Error).message}); trying ${opts.fallbackPort}`);
        server.listen(opts.fallbackPort, "127.0.0.1", onListen);
        return;
      }
      reject(new CliError(`Could not start callback server: ${(e as Error).message}`, ExitCode.AUTH));
    });
    function onListen(): void {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port,
        redirectUri: `http://localhost:${port}${cbPath}`,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
        waitForCode: (timeoutMs: number) => {
          const timeout = new Promise<never>((_, rej) =>
            setTimeout(
              () => rej(new CliError("Timed out waiting for browser authorization", ExitCode.AUTH)),
              timeoutMs,
            ),
          );
          return Promise.race([codePromise, timeout]);
        },
      });
    }
    server.listen(opts.port, "127.0.0.1", onListen);
  });
}

/** Best-effort cross-platform browser opener. */
export function openUrl(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      // Empty title arg keeps URLs with & intact.
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch (e) {
    log.debug(`could not open browser automatically: ${(e as Error).message}`);
  }
}
