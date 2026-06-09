import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { rawRequest } from "./http";
import { CliError, ExitCode } from "./errors";
import { log } from "./logger";
import { userAgent } from "./version";
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

async function tokenRequest(
  baseUrl: string,
  body: URLSearchParams,
  clientId?: string,
  clientSecret?: string,
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": userAgent(),
  };
  // Per docs, client authentication uses HTTP Basic when a secret is available.
  if (clientId && clientSecret) {
    headers["Authorization"] = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  } else if (clientId) {
    body.set("client_id", clientId);
  }

  const url = new URL("/oauth/token", baseUrl).toString();
  const res = await rawRequest(url, { method: "POST", headers, body: body.toString() });

  let json: any;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = { raw: res.body };
  }
  // Some EasyParcel responses wrap the payload in { status_code, message, data }.
  const token: any = json?.access_token ? json : json?.data?.access_token ? json.data : null;
  if (res.status >= 400 || json?.error || !token) {
    const detail = json?.error_description || json?.message || json?.error;
    const snippet = detail ? "" : ` — response body: ${(res.body || "(empty)").slice(0, 400).replace(/\s+/g, " ")}`;
    const msg = detail || `unexpected token response (HTTP ${res.status})`;
    throw new CliError(`OAuth token request failed: ${msg}${snippet}`, ExitCode.AUTH, json);
  }
  return token as TokenResponse;
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
  port: number;
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

    server.on("error", (e) => reject(new CliError(`Could not start callback server: ${(e as Error).message}`, ExitCode.AUTH)));
    server.listen(opts.port, "127.0.0.1", () => {
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
    });
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
