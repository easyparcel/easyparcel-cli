import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { startHttpMcpServer, type HttpMcpServerHandle } from "../src/mcp/http";
import { MCP_ALLOWED_OPERATIONS_ENV } from "../src/mcp/operations";
import { buildContext } from "../src/core/context";
import { log } from "../src/core/logger";

// An all-accounts ("identity") and a one-account sign-in token, as the broker relays them.
const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const future = Math.floor(Date.now() / 1000) + 3600;
const IDENTITY = jwt({ exp: future, token_kind: "identity", user: { id: 7 } });
const ONE_ACCOUNT = jwt({ exp: future, user: { id: 7, account_id: 555 } });
// deploy/k8s/chatgpt-deployment.yaml (test/mcp-allowlist.test.ts pins the manifest to this value).
const CHATGPT_SET =
  "shipment.quote,shipment.list,shipment.details,shipment.track,shipment.insurance-quote,courier.list,courier.dropoff-points,account.list";

interface Hit {
  method?: string;
  url?: string;
  authorization?: string;
  account?: string;
}

let tmp: string;
let upstream: http.Server;
const hits: Hit[] = [];
const handles: HttpMcpServerHandle[] = [];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-broker-identity-"));
  process.env.EASYPARCEL_CONFIG_DIR = tmp;
  delete process.env.EP_MCP_REDIS_URL;
  delete process.env.REDIS_URL;
  // Upstream EasyParcel stand-in: records what the broker sent, answers an empty success.
  upstream = http.createServer((req, res) => {
    hits.push({
      method: req.method,
      url: req.url,
      authorization: req.headers["authorization"] as string | undefined,
      account: req.headers["x-account-id"] as string | undefined,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status_code: 200, message: "Success", data: [] }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const { port } = upstream.address() as AddressInfo;
  buildContext({ baseUrl: `http://127.0.0.1:${port}`, quiet: true, retries: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[MCP_ALLOWED_OPERATIONS_ENV];
});

afterAll(async () => {
  for (const h of handles) await h.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  delete process.env.EASYPARCEL_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Start a broker with the given allow-list (read once, at startup). */
async function start(allowed: string): Promise<string> {
  process.env[MCP_ALLOWED_OPERATIONS_ENV] = allowed;
  const h = await startHttpMcpServer({ port: 0, host: "127.0.0.1", path: "/mcp", requireAuth: true, oauth: false });
  handles.push(h);
  return `http://127.0.0.1:${h.port}/mcp`;
}

async function rpc(url: string, body: unknown, bearer: string, sid?: string): Promise<{ sid?: string; msg: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
      ...(sid ? { "Mcp-Session-Id": sid, "MCP-Protocol-Version": "2025-06-18" } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .pop();
  const raw = data ?? text;
  return { sid: res.headers.get("mcp-session-id") ?? sid, msg: raw ? JSON.parse(raw) : undefined };
}

async function session(url: string, bearer: string): Promise<string> {
  const init = await rpc(
    url,
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    bearer,
  );
  await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" }, bearer, init.sid);
  return init.sid!;
}

const callTool = (url: string, bearer: string, sid: string, name: string, args: Record<string, unknown>) =>
  rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }, bearer, sid);

describe("ChatGPT broker surface with an all-accounts sign-in (B6)", () => {
  it("starts without a listing warning and lists ep_account_list among eight read-only tools", async () => {
    const warn = vi.spyOn(log, "warn");
    const url = await start(CHATGPT_SET);
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/leaves out/);
    const sid = await session(url, IDENTITY);
    const { msg } = await rpc(url, { jsonrpc: "2.0", id: 3, method: "tools/list" }, IDENTITY, sid);
    const names = msg.result.tools.map((t: { name: string }) => t.name);
    expect(names).toHaveLength(8);
    expect(names).toContain("ep_account_list");
    expect(names).not.toContain("ep_shipment_submit");
    expect(names).not.toContain("ep_shipment_cancel");
  });

  it("ep_account_list goes out with the identity bearer and no X-Account-Id; the next tool names the account", async () => {
    const url = await start(CHATGPT_SET);
    const sid = await session(url, IDENTITY);
    hits.length = 0;
    const listed = await callTool(url, IDENTITY, sid, "ep_account_list", {});
    expect(listed.msg.result.isError).toBeFalsy();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ method: "GET", url: "/open_api/2026-03/account/list_accounts", authorization: `Bearer ${IDENTITY}`, account: undefined });
    await callTool(url, IDENTITY, sid, "ep_shipment_list", { account_id: 123 });
    expect(hits).toHaveLength(2);
    expect(hits[1]).toEqual({ method: "POST", url: "/open_api/2026-03/shipment/list", authorization: `Bearer ${IDENTITY}`, account: "123" });
  });

  it("a one-account session sends what it sent before: its bearer and no X-Account-Id", async () => {
    const url = await start(CHATGPT_SET);
    const sid = await session(url, ONE_ACCOUNT);
    hits.length = 0;
    await callTool(url, ONE_ACCOUNT, sid, "ep_shipment_list", {});
    expect(hits).toEqual([{ method: "POST", url: "/open_api/2026-03/shipment/list", authorization: `Bearer ${ONE_ACCOUNT}`, account: undefined }]);
  });
});

describe("broker startup: allow-list that leaves out a listing", () => {
  it("warns once, naming account.list, and still serves exactly the listed tools", async () => {
    const warn = vi.spyOn(log, "warn");
    const url = await start("shipment.quote,shipment.track");
    const listingWarnings = warn.mock.calls.map((c) => c[0]).filter((m) => m.includes("leaves out"));
    expect(listingWarnings).toEqual([
      `${MCP_ALLOWED_OPERATIONS_ENV} leaves out account.list: an all-accounts sign-in on this server ` +
        "cannot discover the account_id its tools need. Add account.list to the list.",
    ]);
    const sid = await session(url, IDENTITY);
    const { msg } = await rpc(url, { jsonrpc: "2.0", id: 3, method: "tools/list" }, IDENTITY, sid);
    expect(msg.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["ep_shipment_quote", "ep_shipment_track"]);
  });

  it("stays quiet when every operation is exposed", async () => {
    const warn = vi.spyOn(log, "warn");
    process.env[MCP_ALLOWED_OPERATIONS_ENV] = "";
    const h = await startHttpMcpServer({ port: 0, host: "127.0.0.1", path: "/mcp", requireAuth: true, oauth: false });
    handles.push(h);
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/leaves out/);
  });
});
