import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startHttpMcpServer, invalidTokenChallenge, type HttpMcpServerHandle } from "../src/mcp/http";
import { buildContext } from "../src/core/context";

const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const expired = jwt({ exp: Math.floor(Date.now() / 1000) - 60, user: { id: "u" } });

let tmp: string;
let upstream: http.Server;
let upstreamHits = 0;
let upstreamAccount: string | undefined;
const handles: HttpMcpServerHandle[] = [];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-broker-"));
  process.env.EASYPARCEL_CONFIG_DIR = tmp;
  delete process.env.EP_MCP_REDIS_URL;
  delete process.env.REDIS_URL;
  // Upstream EasyParcel stand-in: every call is an expired/invalid token.
  upstream = http.createServer((req, res) => {
    upstreamHits++;
    upstreamAccount = req.headers["x-account-id"] as string | undefined;
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status_code: 401, message: "Invalid Access Token" }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const { port } = upstream.address() as AddressInfo;
  buildContext({ baseUrl: `http://127.0.0.1:${port}`, quiet: true, retries: 0 });
});

afterAll(async () => {
  for (const h of handles) await h.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  delete process.env.EASYPARCEL_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function start(oauth: boolean): Promise<string> {
  const h = await startHttpMcpServer({
    port: 0,
    host: "127.0.0.1",
    path: "/mcp",
    requireAuth: true,
    oauth,
    publicUrl: "https://mcp.example.test",
  });
  handles.push(h);
  return `http://127.0.0.1:${h.port}/mcp`;
}

function post(url: string, body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

/** The JSON-RPC messages in an SSE (or plain JSON) response. */
async function messages(res: Response): Promise<any[]> {
  const text = await res.text();
  if ((res.headers.get("content-type") || "").includes("application/json")) return [JSON.parse(text)];
  return text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)));
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

describe("hosted broker: expired bearer pre-check (S9)", () => {
  it("answers 401 + WWW-Authenticate invalid_token for an expired JWT (no OAuth proxy)", async () => {
    const url = await start(false);
    const res = await post(url, initialize, { Authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="easyparcel", error="invalid_token"');
    const body = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32000);
  });

  it("points at the resource metadata when the OAuth proxy is enabled", async () => {
    const url = await start(true);
    const res = await post(url, initialize, { Authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") || "";
    expect(challenge).toMatch(/^Bearer resource_metadata="https:\/\/mcp\.example\.test\/[^"]+", error="invalid_token"$/);
    expect(challenge).toBe(invalidTokenChallenge(challenge.match(/resource_metadata="([^"]+)"/)![1]));
  });

  it("lets a JWT that has not expired through", async () => {
    const url = await start(false);
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, user: { id: "u", account_id: 1 } });
    const res = await post(url, initialize, { Authorization: `Bearer ${fresh}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });
});

describe("hosted broker: upstream 401 invalidates the session (S9)", () => {
  it("returns the isError result, then 401 for the same bearer, and clears on a new bearer", async () => {
    const url = await start(false);
    const init = await post(url, initialize, { Authorization: "Bearer tok-1" });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id")!;
    await messages(init);
    const common = { "Mcp-Session-Id": sid, "MCP-Protocol-Version": "2025-06-18" };
    const notified = await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, { ...common, Authorization: "Bearer tok-1" });
    expect(notified.status).toBe(202);

    const call = await post(
      url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ep_account_wallet", arguments: { account_id: 7 } } },
      { ...common, Authorization: "Bearer tok-1" },
    );
    expect(call.status).toBe(200);
    const [result] = await messages(call);
    expect(result.result.isError).toBe(true);
    expect(upstreamHits).toBeGreaterThan(0);
    expect(upstreamAccount).toBe("7"); // the tool's account_id reached upstream as X-Account-Id

    const again = await post(url, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { ...common, Authorization: "Bearer tok-1" });
    expect(again.status).toBe(401);
    expect(again.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const refreshed = await post(url, { jsonrpc: "2.0", id: 4, method: "tools/list" }, { ...common, Authorization: "Bearer tok-2" });
    expect(refreshed.status).toBe(200);
    const [list] = await messages(refreshed);
    expect(list.result.tools.length).toBeGreaterThan(0);
  });
});
