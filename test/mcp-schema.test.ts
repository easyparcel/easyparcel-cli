import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, splitTargetArgs, toolInputSchema } from "../src/mcp/server";
import { OPERATIONS, mcpToolName } from "../src/operations";
import { buildContext } from "../src/core/context";
import type { RunInput } from "../src/cli/run";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-mcp-"));
  process.env.EASYPARCEL_CONFIG_DIR = tmp;
  delete process.env.EASYPARCEL_ACCOUNT_ID;
  delete process.env.EASYPARCEL_ORGANIZATION_ID;
  buildContext({ quiet: true });
});

afterAll(() => {
  delete process.env.EASYPARCEL_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connect(server: ReturnType<typeof buildServer>): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("MCP tool schemas", () => {
  it("every tool accepts optional account_id and organization_id", () => {
    for (const op of OPERATIONS) {
      const schema = toolInputSchema(op) as { properties: Record<string, any>; required?: string[] };
      expect(schema.properties.account_id, op.id).toBeDefined();
      expect(schema.properties.organization_id, op.id).toBeDefined();
      expect(schema.properties.account_id.description).toBe("Shipping account to act on. List them with ep_account_list.");
      expect(schema.required ?? []).not.toContain("account_id");
      expect(schema.required ?? []).not.toContain("organization_id");
    }
  });

  it("lists ep_account_list and ep_organization_list from the registry", async () => {
    const client = await connect(buildServer());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("ep_account_list");
    expect(names).toContain("ep_organization_list");
    expect(names).toContain("ep_account_info");
    const wallet = tools.find((t) => t.name === "ep_account_wallet")!;
    expect(Object.keys(wallet.inputSchema.properties ?? {})).toEqual(["account_id", "organization_id"]);
    expect(mcpToolName(OPERATIONS.find((o) => o.id === "organization.list")!)).toBe("ep_organization_list");
  });
});

describe("MCP CallTool target handling", () => {
  it("strips account_id / organization_id from the body and forwards them as headers", async () => {
    const calls: RunInput[] = [];
    const execute = vi.fn(async (_ctx: unknown, _op: unknown, input: RunInput = {}) => {
      calls.push(input);
      return { status_code: 200, data: { ok: true } };
    });
    const client = await connect(buildServer("client-token", { execute: execute as any }));

    await client.callTool({
      name: "ep_shipment_quote",
      arguments: { shipment: [{ weight: 1 }], account_id: 123, organization_id: "ABCDEF" },
    });
    expect(calls[0].body).toEqual({ shipment: [{ weight: 1 }] });
    expect(calls[0].headers).toEqual({ "X-Account-Id": "123", "X-Organization-Id": "ABCDEF" });
    expect(calls[0].accessToken).toBe("client-token");

    // No-body tool: the target params are accepted and never become a body.
    await client.callTool({ name: "ep_account_wallet", arguments: { account_id: "456" } });
    expect(calls[1].body).toBeUndefined();
    expect(calls[1].headers).toEqual({ "X-Account-Id": "456" });

    // No target → no headers.
    await client.callTool({ name: "ep_account_list", arguments: {} });
    expect(calls[2].headers).toEqual({});
  });

  it("rejects a malformed account_id without calling the API", async () => {
    const execute = vi.fn();
    const client = await connect(buildServer(undefined, { execute: execute as any }));
    const res = await client.callTool({ name: "ep_account_wallet", arguments: { account_id: "abc" } });
    expect(res.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("adds the ep_account_list hint on ACCOUNT_HEADER_REQUIRED and reports upstream 401s", async () => {
    const onUnauthorized = vi.fn();
    const responses = [
      { status_code: 400, code: "ACCOUNT_HEADER_REQUIRED", message: "X-Account-Id required", data: null, _http_status: 400 },
      { status_code: 401, message: "Invalid Access Token", data: null, _http_status: 401 },
    ];
    const execute = vi.fn(async () => responses.shift()!);
    const client = await connect(buildServer(() => "client-token", { execute: execute as any, onUnauthorized }));

    const first = await client.callTool({ name: "ep_account_wallet", arguments: {} });
    expect(first.isError).toBe(true);
    expect((first.content as Array<{ text: string }>)[0].text).toContain("ep_account_list");
    expect(onUnauthorized).not.toHaveBeenCalled();

    const second = await client.callTool({ name: "ep_account_wallet", arguments: {} });
    expect(second.isError).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe("splitTargetArgs", () => {
  it("leaves the remaining arguments untouched", () => {
    expect(splitTargetArgs({ a: 1, account_id: "", organization_id: null })).toEqual({ rest: { a: 1 }, headers: {} });
  });
});
