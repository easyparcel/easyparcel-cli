import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp/server";
import { getMcpOperations, missingTargetListings, missingTargetListingsWarning, MCP_ALLOWED_OPERATIONS_ENV } from "../src/mcp/operations";
import { OPERATIONS } from "../src/operations";
import type { Operation } from "../src/operations/types";
import { buildContext } from "../src/core/context";

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-mcp-allow-"));
  process.env.EASYPARCEL_CONFIG_DIR = tmp;
  buildContext({ quiet: true });
});

afterAll(() => {
  delete process.env.EASYPARCEL_CONFIG_DIR;
  delete process.env[MCP_ALLOWED_OPERATIONS_ENV];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function connect(server: ReturnType<typeof buildServer>): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

// The read-only set the hosted ChatGPT broker runs with (deploy/k8s/chatgpt-deployment.yaml).
const CHATGPT_SET = "shipment.quote,shipment.list,shipment.details,shipment.track,shipment.insurance-quote,courier.list,courier.dropoff-points,account.list";

describe("EP_MCP_ALLOWED_OPERATIONS", () => {
  it("unset or blank exposes every operation", () => {
    expect(getMcpOperations({})).toBe(OPERATIONS);
    expect(getMcpOperations({ [MCP_ALLOWED_OPERATIONS_ENV]: "   " })).toBe(OPERATIONS);
  });

  it("accepts operation ids and tool names, keeps the given order and drops duplicates", () => {
    const ops = getMcpOperations({ [MCP_ALLOWED_OPERATIONS_ENV]: " shipment.track, ep_shipment_quote ,shipment.track" });
    expect(ops.map((o) => o.id)).toEqual(["shipment.track", "shipment.quote"]);
  });

  it("resolves the ChatGPT broker's read-only set to eight non-mutating operations, ep_account_list included", () => {
    const ops = getMcpOperations({ [MCP_ALLOWED_OPERATIONS_ENV]: CHATGPT_SET });
    expect(ops).toHaveLength(8);
    expect(ops.every((o) => !o.mutating)).toBe(true);
    expect(ops.map((o) => o.id)).toContain("account.list");
    expect(missingTargetListings(ops)).toEqual([]);
    expect(missingTargetListingsWarning(ops)).toBeUndefined();
  });

  it("the ChatGPT deployment manifest runs exactly the set tested here", () => {
    const yaml = fs.readFileSync(new URL("../deploy/k8s/chatgpt-deployment.yaml", import.meta.url), "utf8");
    const m = /name: EP_MCP_ALLOWED_OPERATIONS\s*\n\s*value:\s*(\S+)/.exec(yaml);
    expect(m?.[1]).toBe(CHATGPT_SET);
  });

  it("reports the listing a narrowed surface leaves out, without adding it", () => {
    const ops = getMcpOperations({ [MCP_ALLOWED_OPERATIONS_ENV]: "shipment.quote,shipment.track" });
    expect(missingTargetListings(ops)).toEqual(["account.list"]);
    expect(ops.map((o) => o.id)).toEqual(["shipment.quote", "shipment.track"]);
    expect(missingTargetListingsWarning(ops)).toBe(
      `${MCP_ALLOWED_OPERATIONS_ENV} leaves out account.list: an all-accounts sign-in on this server ` +
        "cannot discover the account_id its tools need. Add account.list to the list.",
    );
    expect(missingTargetListings(OPERATIONS)).toEqual([]);
    expect(missingTargetListings(getMcpOperations({ [MCP_ALLOWED_OPERATIONS_ENV]: "account.list" }))).toEqual([]);
  });

  it("reports organization.list for organization-scoped tools, and both in a fixed order", () => {
    const orgTool = { id: "org.thing", scope: "organization" } as Operation;
    const accountTool = { id: "account.thing" } as Operation;
    const orgList = { id: "organization.list", target: false } as Operation;
    expect(missingTargetListings([orgTool])).toEqual(["organization.list"]);
    expect(missingTargetListings([orgTool, orgList])).toEqual([]);
    expect(missingTargetListings([orgTool, accountTool])).toEqual(["account.list", "organization.list"]);
    expect(missingTargetListingsWarning([orgTool, accountTool])).toMatch(
      /leaves out account\.list, organization\.list: .* the account_id \/ organization_id its tools need\. Add account\.list,organization\.list to the list\.$/,
    );
    expect(missingTargetListings([orgList])).toEqual([]);
  });

  it("refuses unknown names and an empty list", () => {
    expect(() => getMcpOperations({ [MCP_ALLOWED_OPERATIONS_ENV]: "shipment.quote,nope.thing" })).toThrow(/unknown operation\(s\): nope\.thing/);
    expect(() => getMcpOperations({ [MCP_ALLOWED_OPERATIONS_ENV]: " , " })).toThrow(/at least one operation id/);
  });

  it("the server lists only the allowed tools and refuses the others", async () => {
    const operations = getMcpOperations({ [MCP_ALLOWED_OPERATIONS_ENV]: "shipment.quote,shipment.track" });
    const client = await connect(buildServer(undefined, { operations }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ep_shipment_quote", "ep_shipment_track"]);
    const res = await client.callTool({ name: "ep_shipment_submit", arguments: {} });
    expect(res.isError).toBe(true);
    expect(String((res.content as Array<{ text?: string }>)[0]?.text)).toMatch(/Unknown tool: ep_shipment_submit/);
  });

  it("buildServer reads the env by default", async () => {
    process.env[MCP_ALLOWED_OPERATIONS_ENV] = "courier.list";
    try {
      const client = await connect(buildServer());
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["ep_courier_list"]);
    } finally {
      delete process.env[MCP_ALLOWED_OPERATIONS_ENV];
    }
  });
});
