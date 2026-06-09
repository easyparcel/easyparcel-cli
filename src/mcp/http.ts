import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { OPERATIONS } from "../operations";
import { buildServer } from "./server";
import { createOAuthProxy, type OAuthProxy } from "./oauth";
import { createOAuthStore, seedOAuthClients, type OAuthStore } from "./store";
import { getContext } from "../core/context";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } from "../core/config";
import { log } from "../core/logger";

export interface HttpMcpOptions {
  port: number;
  host: string;
  /** Endpoint path the MCP client posts to (default "/mcp"). */
  path: string;
  /** Reject requests without an Authorization: Bearer token (recommended when hosted). */
  requireAuth: boolean;
  /** Enable the OAuth 2.1 authorization-server proxy (for ChatGPT connectors). Implies requireAuth. */
  oauth: boolean;
  /** Public HTTPS base URL clients reach (e.g. https://mcp.easyparcel.com). Used in OAuth
   *  metadata + redirect URIs. If omitted, derived from request Host / X-Forwarded headers. */
  publicUrl?: string;
  /** EasyParcel OAuth client id the proxy authenticates as upstream. Run one deployment per
   *  source (ChatGPT / Claude / …) with its own client id for independent attribution. */
  epClientId?: string;
  epClientSecret?: string;
}

/** Read and JSON-parse a request body (StreamableHTTPServerTransport wants the parsed body for POSTs). */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(h) ? h[0] : h);
  return m ? m[1].trim() : undefined;
}

// Favicon: fetched once from the main site and cached in memory, then served same-origin
// so favicon crawlers (Google, ChatGPT/Claude directory) get a 200 image, not a redirect.
const FAVICON_SOURCE = process.env.EASYPARCEL_FAVICON_URL || "https://easyparcel.com/favicon.ico";
let faviconCache: Buffer | null = null;
let faviconTried = false;
async function getFavicon(): Promise<Buffer | null> {
  if (faviconCache || faviconTried) return faviconCache;
  faviconTried = true;
  try {
    const r = await fetch(FAVICON_SOURCE, { signal: AbortSignal.timeout(8000) });
    if (r.ok) faviconCache = Buffer.from(await r.arrayBuffer());
  } catch {
    /* fall back to a redirect on the next request */
    faviconTried = false;
  }
  return faviconCache;
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function jsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * Run the EasyParcel MCP server over Streamable HTTP (the transport used by remote
 * MCP clients such as ChatGPT app connectors). Each client gets an isolated session;
 * its bearer token (sent on the initialize request) is bound to that session and used
 * for every EasyParcel API call it makes.
 */
export async function runHttpMcpServer(opts: HttpMcpOptions): Promise<void> {
  // One transport (and one Server, bound to that client's token) per MCP session.
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const endpoint = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const requireAuth = opts.requireAuth || opts.oauth;

  // Per-source attribution: the upstream EasyParcel client this proxy authenticates as.
  // Run one deployment per source (ChatGPT / Claude / …) with its own --ep-client-id.
  const epClientId = opts.epClientId || process.env.EASYPARCEL_CLIENT_ID || DEFAULT_CLIENT_ID;
  const epClientSecret =
    opts.epClientSecret ||
    process.env.EASYPARCEL_CLIENT_SECRET ||
    (epClientId === DEFAULT_CLIENT_ID ? DEFAULT_CLIENT_SECRET || undefined : undefined);

  // OAuth proxy state store: Redis (durable across rollouts + multi-replica) when
  // EP_MCP_REDIS_URL/REDIS_URL is set, else in-memory. Namespaced per upstream client id so the
  // ChatGPT / Claude / general deployments can share one Redis without colliding.
  let oauthStore: OAuthStore | null = null;
  let oauthDurable = false;
  if (opts.oauth) {
    const redisUrl = process.env.EP_MCP_REDIS_URL || process.env.REDIS_URL || undefined;
    ({ store: oauthStore, durable: oauthDurable } = await createOAuthStore({ redisUrl, namespace: epClientId }));
    // Pre-register known clients (e.g. an already-installed ChatGPT connector whose registration
    // was lost when an older pod was replaced) so they authorize without needing to re-add.
    await seedOAuthClients(oauthStore, process.env.EP_MCP_SEED_CLIENTS);
  }

  const oauth: OAuthProxy | null =
    opts.oauth && oauthStore
      ? createOAuthProxy({
          easyparcelBaseUrl: getContext().baseUrl,
          clientId: epClientId,
          clientSecret: epClientSecret,
          store: oauthStore,
        })
      : null;
  if (oauth) log.info(`OAuth proxy upstream EasyParcel client: ${epClientId}`);

  const fallbackHost = opts.host === "0.0.0.0" ? "localhost" : opts.host;
  /** Resolve the externally-visible base URL for OAuth metadata/redirects. */
  function publicBaseFor(req: http.IncomingMessage): string {
    if (opts.publicUrl) return opts.publicUrl.replace(/\/+$/, "");
    const fwdProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0]?.trim();
    const fwdHost = String(req.headers["x-forwarded-host"] || "").split(",")[0]?.trim();
    const proto = fwdProto || "http";
    const host = fwdHost || req.headers.host || `${fallbackHost}:${opts.port}`;
    return `${proto}://${host}`;
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      log.error(`HTTP MCP handler error: ${(e as Error).message}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // OAuth 2.1 discovery / authorize / token / register (for ChatGPT connectors).
    if (oauth && (await oauth.tryHandle(req, res, url, publicBaseFor(req)))) return;

    // Serve the favicon SAME-ORIGIN (clients like Google's favicon service won't follow a
    // cross-domain redirect, so the icon must be returned here, not 302'd elsewhere).
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      const ico = await getFavicon();
      if (ico) {
        res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" });
        res.end(ico);
      } else {
        res.writeHead(302, { Location: FAVICON_SOURCE });
        res.end();
      }
      return;
    }

    // Health endpoint stays JSON (used by k8s/ALB probes and uptime checks).
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { name: "easyparcel-mcp", status: "ok", tools: OPERATIONS.length, endpoint });
      return;
    }

    // Root: HTML for browsers/favicon crawlers (so they can discover <link rel="icon">),
    // JSON otherwise. Favicon services like Google read the icon link from the root HTML.
    if (req.method === "GET" && url.pathname === "/") {
      if (String(req.headers["accept"] || "").includes("text/html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8">` +
            `<link rel="icon" href="/favicon.ico" type="image/x-icon">` +
            `<title>EasyParcel MCP</title></head>` +
            `<body style="font-family:system-ui,sans-serif;padding:2rem;color:#334155">` +
            `<h1>EasyParcel MCP server</h1>` +
            `<p>Model Context Protocol endpoint: <code>${endpoint}</code>. ` +
            `Docs: <a href="https://github.com/easyparcel/easyparcel-cli">github.com/easyparcel/easyparcel-cli</a></p>` +
            `</body></html>`,
        );
        return;
      }
      sendJson(res, 200, { name: "easyparcel-mcp", status: "ok", tools: OPERATIONS.length, endpoint });
      return;
    }

    if (url.pathname !== endpoint) {
      jsonRpcError(res, 404, `Not found. MCP endpoint is ${endpoint}`);
      return;
    }

    // Gate the MCP endpoint. A 401 with WWW-Authenticate pointing at the protected-resource
    // metadata is how MCP clients (ChatGPT) discover the authorization server and start OAuth.
    if (requireAuth && !bearerToken(req)) {
      const challenge = oauth
        ? `Bearer resource_metadata="${oauth.resourceMetadataUrl(publicBaseFor(req))}"`
        : 'Bearer realm="easyparcel", error="invalid_token"';
      res.setHeader("WWW-Authenticate", challenge);
      jsonRpcError(res, 401, "Authentication required. Authorize via OAuth or send 'Authorization: Bearer <token>'.");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    // Existing session: route GET (SSE stream), POST (messages) and DELETE (teardown).
    if (sid && sessions.has(sid)) {
      const transport = sessions.get(sid)!;
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);
      return;
    }

    // New session: only valid on a POST carrying the JSON-RPC `initialize` request.
    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (!isInitializeRequest(body)) {
        jsonRpcError(res, 400, "No valid session. The first request must be an MCP 'initialize'.");
        return;
      }

      const token = bearerToken(req);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, transport);
          log.info(`MCP session ${id} initialized (${token ? "token-authed" : "local creds"}).`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      // Bind this client's token to its own Server instance for the life of the session.
      const mcp = buildServer(token);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    jsonRpcError(res, 400, "No valid MCP session id.");
  }

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });

  log.info(
    `EasyParcel MCP server (Streamable HTTP) on http://${fallbackHost}:${opts.port}${endpoint} ` +
      `(${OPERATIONS.length} tools, auth ${requireAuth ? "required" : "optional"}` +
      `${oauth ? ", OAuth proxy enabled" : ""}).`,
  );
  if (oauth) {
    if (!oauthDurable) {
      log.warn(
        "OAuth proxy keeps registered clients, codes and pending auth IN MEMORY — run a SINGLE replica " +
          "(or sticky sessions), and note a rollout/restart drops registrations (clients hit invalid_client). " +
          "Set EP_MCP_REDIS_URL to persist state across restarts and scale to multiple replicas.",
      );
    }
    if (!opts.publicUrl) {
      log.warn("No --public-url set: OAuth URLs are derived from request headers. Set --public-url behind a proxy.");
    }
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      for (const t of sessions.values()) void t.close();
      if (oauthStore) void oauthStore.close();
      server.close(() => resolve());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
