import { describe, it, expect, afterEach, vi } from "vitest";

// The real stdio transport would read this test process's stdin and write MCP frames to its stdout.
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    async start(): Promise<void> {}
    async send(): Promise<void> {}
    async close(): Promise<void> {}
  },
}));

import { runMcpServer } from "../src/mcp/server";
import { MCP_ALLOWED_OPERATIONS_ENV } from "../src/mcp/operations";
import { log } from "../src/core/logger";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[MCP_ALLOWED_OPERATIONS_ENV];
});

/** Start the stdio server (it then waits for stdin to close, so it is not awaited) and collect its log lines. */
async function startStdio(allowed?: string): Promise<{ warnings: string[] }> {
  if (allowed !== undefined) process.env[MCP_ALLOWED_OPERATIONS_ENV] = allowed;
  const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  const info = vi.spyOn(log, "info").mockImplementation(() => {});
  void runMcpServer();
  await vi.waitFor(() => expect(info.mock.calls.flat().join("\n")).toMatch(/running on stdio/));
  return { warnings: warn.mock.calls.map((c) => c[0]).filter((m) => m.includes("leaves out")) };
}

describe("stdio MCP server startup: allow-list that leaves out a listing", () => {
  it("warns once, naming account.list, and still starts", async () => {
    const { warnings } = await startStdio("shipment.quote,shipment.track");
    expect(warnings).toEqual([
      `${MCP_ALLOWED_OPERATIONS_ENV} leaves out account.list: an all-accounts sign-in on this server ` +
        "cannot discover the account_id its tools need. Add account.list to the list.",
    ]);
  });

  it("stays quiet when every operation is exposed", async () => {
    const { warnings } = await startStdio();
    expect(warnings).toEqual([]);
  });
});
