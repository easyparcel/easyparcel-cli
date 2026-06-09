import http from "node:http";
import crypto from "node:crypto";
import { buildAuthUrl, exchangeCode, refreshToken } from "../core/oauth";
import { log } from "../core/logger";
import type { OAuthStore } from "./store";

/**
 * OAuth 2.1 authorization-server *proxy* for the HTTP MCP server.
 *
 * ChatGPT (and any MCP client following the MCP authorization spec) performs the
 * full OAuth dance — discovery, dynamic client registration, authorization-code +
 * PKCE — against THIS server. We don't store passwords or own identities: we relay
 * the user to EasyParcel's existing OAuth (`/oauth/login` + `/oauth/token`, the same
 * one `ep auth login` uses) with our built-in EasyParcel client, then hand the client
 * the resulting EasyParcel access token. Subsequent MCP calls carry that token as a
 * Bearer, which the per-session Server uses directly against the EasyParcel API.
 *
 * Endpoints served:
 *   GET  /.well-known/oauth-protected-resource   (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server (RFC 8414)
 *   POST /register                               (RFC 7591 dynamic client registration)
 *   GET  /authorize                              (authorization endpoint, PKCE required)
 *   GET  /oauth/callback                         (callback from EasyParcel)
 *   POST /token                                  (token endpoint: code + refresh grants)
 *
 * State lives in a pluggable OAuthStore (in-memory by default, Redis when EP_MCP_REDIS_URL is
 * set). Registered clients, pending authorizations and issued codes all expire via the store's
 * TTL; codes are single-use. With Redis the state survives rollouts and is shared across replicas.
 */

export interface OAuthProxyOptions {
  /** EasyParcel API/OAuth base (e.g. https://api.easyparcel.com) — same as ctx.baseUrl. */
  easyparcelBaseUrl: string;
  /** Built-in EasyParcel OAuth client id (public client). */
  clientId: string;
  /** Built-in client secret, if the app is confidential (usually empty). */
  clientSecret?: string;
  /** Advertised scopes (EasyParcel has no granular scopes; informational). */
  scopes?: string[];
  /** Backing store for registered clients, pending auths and one-time codes (in-memory or Redis). */
  store: OAuthStore;
}

interface RegisteredClient {
  redirectUris: string[];
  name?: string;
  createdAt: number;
}

interface PendingAuth {
  clientId: string;
  clientRedirectUri: string;
  clientState?: string;
  clientCodeChallenge: string;
  clientCodeChallengeMethod: string;
  scope?: string;
  upstreamVerifier: string;
  upstreamRedirectUri: string;
  createdAt: number;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  epAccessToken: string;
  epRefreshToken?: string;
  epExpiresIn?: number;
  epTokenType?: string;
  createdAt: number;
}

const TEN_MIN = 10 * 60 * 1000;
const CLIENT_TTL = 30 * 24 * 60 * 60 * 1000; // registered clients expire after ~30d
const MAX_CLIENTS = 1000; // hard cap so unauthenticated /register can't grow memory unbounded

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomId(bytes = 32): string {
  return base64url(crypto.randomBytes(bytes));
}
/** Verify a PKCE code_verifier against a stored S256 challenge. */
function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method === "plain") return verifier === challenge;
  const computed = base64url(crypto.createHash("sha256").update(verifier).digest());
  // constant-time compare on equal-length buffers
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function oauthError(res: http.ServerResponse, status: number, error: string, desc?: string): void {
  sendJson(res, status, { error, ...(desc ? { error_description: desc } : {}) });
}

function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const ct = String(req.headers["content-type"] || "");
      try {
        if (ct.includes("application/json")) {
          const j = raw ? JSON.parse(raw) : {};
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(j)) out[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
          resolve({ ...out, __json: raw });
        } else {
          const p = new URLSearchParams(raw);
          const out: Record<string, string> = {};
          for (const [k, v] of p.entries()) out[k] = v;
          resolve(out);
        }
      } catch {
        reject(new Error("invalid body"));
      }
    });
    req.on("error", reject);
  });
}

function errorRedirect(res: http.ServerResponse, redirectUri: string, error: string, state?: string, desc?: string): void {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (desc) u.searchParams.set("error_description", desc);
  if (state) u.searchParams.set("state", state);
  res.writeHead(302, { Location: u.toString() });
  res.end();
}

export interface OAuthProxy {
  /** Handle an OAuth/discovery request. Returns true if it owned the request. */
  tryHandle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, publicBase: string): Promise<boolean>;
  /** URL of the protected-resource metadata, for the 401 WWW-Authenticate header. */
  resourceMetadataUrl(publicBase: string): string;
}

export function createOAuthProxy(opts: OAuthProxyOptions): OAuthProxy {
  const store = opts.store;
  const scopes = opts.scopes ?? ["easyparcel"];
  // TTLs are enforced by the store (in-memory expiry or Redis PX); no manual sweep needed.

  function resourceMetadataUrl(publicBase: string): string {
    return `${publicBase}/.well-known/oauth-protected-resource`;
  }

  async function tryHandle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    publicBase: string,
  ): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? "GET";

    // --- Protected Resource Metadata (RFC 9728) ---
    if (path === "/.well-known/oauth-protected-resource") {
      sendJson(res, 200, {
        resource: publicBase,
        authorization_servers: [publicBase],
        bearer_methods_supported: ["header"],
        scopes_supported: scopes,
      });
      return true;
    }

    // --- Authorization Server Metadata (RFC 8414) ---
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") {
      sendJson(res, 200, {
        issuer: publicBase,
        authorization_endpoint: `${publicBase}/authorize`,
        token_endpoint: `${publicBase}/token`,
        registration_endpoint: `${publicBase}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: scopes,
      });
      return true;
    }

    // --- Dynamic Client Registration (RFC 7591) ---
    if (path === "/register" && method === "POST") {
      let body: Record<string, string>;
      try {
        body = await readBody(req);
      } catch {
        oauthError(res, 400, "invalid_request", "could not parse registration body");
        return true;
      }
      let meta: any = {};
      try {
        meta = body.__json ? JSON.parse(body.__json) : body;
      } catch {
        /* fall back to flat body */
        meta = body;
      }
      const redirectUris: string[] = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
      if (redirectUris.length === 0) {
        oauthError(res, 400, "invalid_redirect_uri", "redirect_uris is required");
        return true;
      }
      const bad = redirectUris.find((u) => {
        try {
          const parsed = new URL(u);
          return parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1";
        } catch {
          return true;
        }
      });
      if (bad) {
        oauthError(res, 400, "invalid_redirect_uri", `redirect_uri must be https (or localhost): ${bad}`);
        return true;
      }
      // Cap unauthenticated /register growth (RFC 7591). Records also expire via store TTL;
      // at the cap we shed load rather than evict, since a shared store has no cheap "oldest".
      if ((await store.count("client")) >= MAX_CLIENTS) {
        oauthError(res, 503, "temporarily_unavailable", "client registration limit reached; retry later");
        return true;
      }
      const clientId = randomId(24);
      await store.set("client", clientId, { redirectUris, name: meta.client_name, createdAt: Date.now() }, CLIENT_TTL);
      log.info(`Registered MCP OAuth client ${clientId} (${meta.client_name ?? "unnamed"}).`);
      sendJson(res, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: meta.client_name,
        scope: scopes.join(" "),
      });
      return true;
    }

    // --- Authorization endpoint ---
    if (path === "/authorize" && method === "GET") {
      const q = url.searchParams;
      const clientId = q.get("client_id") ?? "";
      const redirectUri = q.get("redirect_uri") ?? "";
      const responseType = q.get("response_type");
      const codeChallenge = q.get("code_challenge");
      const codeChallengeMethod = q.get("code_challenge_method") ?? "plain";
      const clientState = q.get("state") ?? undefined;
      const scope = q.get("scope") ?? undefined;

      const client = await store.get<RegisteredClient>("client", clientId);
      // Client / redirect_uri must be valid BEFORE we ever redirect (anti open-redirect).
      if (!client) {
        oauthError(res, 400, "invalid_client", "unknown client_id (register first)");
        return true;
      }
      if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
        oauthError(res, 400, "invalid_request", "redirect_uri not registered for this client");
        return true;
      }
      if (responseType !== "code") {
        errorRedirect(res, redirectUri, "unsupported_response_type", clientState);
        return true;
      }
      if (!codeChallenge || codeChallengeMethod !== "S256") {
        errorRedirect(res, redirectUri, "invalid_request", clientState, "PKCE S256 code_challenge required");
        return true;
      }

      // Start our own authorization-code+PKCE flow with EasyParcel.
      const upstreamState = randomId(18);
      const upstreamVerifier = randomId(32);
      const upstreamChallenge = base64url(crypto.createHash("sha256").update(upstreamVerifier).digest());
      const upstreamRedirectUri = `${publicBase}/oauth/callback`;
      await store.set(
        "pending",
        upstreamState,
        {
          clientId,
          clientRedirectUri: redirectUri,
          clientState,
          clientCodeChallenge: codeChallenge,
          clientCodeChallengeMethod: codeChallengeMethod,
          scope,
          upstreamVerifier,
          upstreamRedirectUri,
          createdAt: Date.now(),
        },
        TEN_MIN,
      );

      // Do NOT relay the client-supplied scope upstream — EasyParcel has no granular scopes,
      // so forwarding arbitrary scope is an uncontrolled passthrough. Pin it (omit).
      const epUrl = buildAuthUrl({
        baseUrl: opts.easyparcelBaseUrl,
        clientId: opts.clientId,
        redirectUri: upstreamRedirectUri,
        challenge: upstreamChallenge,
        state: upstreamState,
      });
      res.writeHead(302, { Location: epUrl });
      res.end();
      return true;
    }

    // --- Callback from EasyParcel ---
    if (path === "/oauth/callback" && method === "GET") {
      const q = url.searchParams;
      const upstreamState = q.get("state") ?? "";
      const epCode = q.get("code");
      const epError = q.get("error");
      const p = await store.get<PendingAuth>("pending", upstreamState);
      if (!p) {
        sendJson(res, 400, { error: "invalid_state", error_description: "unknown or expired authorization state" });
        return true;
      }
      await store.del("pending", upstreamState);
      if (epError || !epCode) {
        errorRedirect(res, p.clientRedirectUri, epError || "access_denied", p.clientState);
        return true;
      }
      try {
        const tr = await exchangeCode({
          baseUrl: opts.easyparcelBaseUrl,
          clientId: opts.clientId,
          clientSecret: opts.clientSecret,
          redirectUri: p.upstreamRedirectUri,
          code: epCode,
          codeVerifier: p.upstreamVerifier,
          state: upstreamState,
        });
        if (!tr.access_token) {
          errorRedirect(res, p.clientRedirectUri, "server_error", p.clientState, "no access token from EasyParcel");
          return true;
        }
        const ourCode = randomId(32);
        await store.set(
          "code",
          ourCode,
          {
            clientId: p.clientId,
            redirectUri: p.clientRedirectUri,
            codeChallenge: p.clientCodeChallenge,
            codeChallengeMethod: p.clientCodeChallengeMethod,
            epAccessToken: tr.access_token,
            epRefreshToken: tr.refresh_token,
            epExpiresIn: tr.expires_in,
            epTokenType: tr.token_type,
            createdAt: Date.now(),
          },
          TEN_MIN,
        );
        const redir = new URL(p.clientRedirectUri);
        redir.searchParams.set("code", ourCode);
        if (p.clientState) redir.searchParams.set("state", p.clientState);
        res.writeHead(302, { Location: redir.toString() });
        res.end();
      } catch (e) {
        log.error(`OAuth callback exchange failed: ${(e as Error).message}`);
        errorRedirect(res, p.clientRedirectUri, "server_error", p.clientState, "token exchange failed");
      }
      return true;
    }

    // --- Token endpoint ---
    if (path === "/token" && method === "POST") {
      let body: Record<string, string>;
      try {
        body = await readBody(req);
      } catch {
        oauthError(res, 400, "invalid_request", "could not parse token request");
        return true;
      }
      const grant = body.grant_type;

      if (grant === "authorization_code") {
        const code = body.code ?? "";
        const verifier = body.code_verifier ?? "";
        const rec = await store.get<IssuedCode>("code", code);
        if (!rec) {
          oauthError(res, 400, "invalid_grant", "unknown or expired authorization code");
          return true;
        }
        await store.del("code", code); // single use
        if (body.client_id && body.client_id !== rec.clientId) {
          oauthError(res, 400, "invalid_grant", "client mismatch");
          return true;
        }
        if (body.redirect_uri && body.redirect_uri !== rec.redirectUri) {
          oauthError(res, 400, "invalid_grant", "redirect_uri mismatch");
          return true;
        }
        if (!verifier || !verifyPkce(verifier, rec.codeChallenge, rec.codeChallengeMethod)) {
          oauthError(res, 400, "invalid_grant", "PKCE verification failed");
          return true;
        }
        sendJson(res, 200, {
          access_token: rec.epAccessToken,
          token_type: rec.epTokenType || "Bearer",
          expires_in: rec.epExpiresIn ?? 3600,
          refresh_token: rec.epRefreshToken,
          scope: scopes.join(" "),
        });
        return true;
      }

      if (grant === "refresh_token") {
        const rt = body.refresh_token;
        if (!rt) {
          oauthError(res, 400, "invalid_request", "refresh_token required");
          return true;
        }
        try {
          const tr = await refreshToken({
            baseUrl: opts.easyparcelBaseUrl,
            clientId: opts.clientId,
            clientSecret: opts.clientSecret,
            refreshToken: rt,
          });
          sendJson(res, 200, {
            access_token: tr.access_token,
            token_type: tr.token_type || "Bearer",
            expires_in: tr.expires_in ?? 3600,
            refresh_token: tr.refresh_token ?? rt,
            scope: scopes.join(" "),
          });
        } catch (e) {
          oauthError(res, 400, "invalid_grant", (e as Error).message);
        }
        return true;
      }

      oauthError(res, 400, "unsupported_grant_type", `grant_type '${grant}' not supported`);
      return true;
    }

    return false;
  }

  return { tryHandle, resourceMetadataUrl };
}
