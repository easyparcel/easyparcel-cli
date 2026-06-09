import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { OPERATIONS, mcpToolName } from "../operations";
import type { Operation } from "../operations/types";
import { executeOperation } from "../cli/run";
import { collectItemErrors, effectiveStatus } from "../core/envelope";
import { getContext } from "../core/context";
import { CliError } from "../core/errors";
import { CLI_VERSION } from "../core/version";
import { log } from "../core/logger";

// Every EasyParcel operation returns the same response envelope, so all tools share one
// outputSchema (helps the model parse `structuredContent`). Batch endpoints put per-item
// results/errors inside `data`.
const ENVELOPE_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "EasyParcel API response envelope.",
  properties: {
    status_code: { type: "number", description: "Status: 200 ok; >= 400 error." },
    request_id: { type: "string", description: "Server-assigned request id." },
    message: { type: "string", description: "Human-readable message (usually on errors)." },
    data: { description: "Result payload; shape varies by tool/operation." },
  },
  additionalProperties: true,
};

function toolInputSchema(op: Operation): Record<string, unknown> {
  if (op.body === "none") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const base: Record<string, unknown> = op.schema
    ? (structuredClone(op.schema) as Record<string, unknown>)
    : { type: "object", properties: {} };
  base.additionalProperties = true; // the API may accept fields beyond our schema
  if (op.example !== undefined) base.examples = [op.example];
  return base;
}

function toolDescription(op: Operation): string {
  const parts = [op.summary + "."];
  if (op.description) parts.push(op.description);
  parts.push(`Endpoint: ${op.method} /open_api/{version}/${op.path}.`);
  if (op.body !== "none") parts.push("The tool arguments ARE the JSON request body.");
  if (op.pagination) parts.push("Cursor-paginated; pass the cursor field to page.");
  if (op.docNote) parts.push(`Note: ${op.docNote}`);
  if (op.mutating) parts.push("MUTATING: this creates/cancels orders and may charge your wallet.");
  return parts.join(" ");
}

/**
 * Build an MCP Server exposing every EasyParcel operation as a tool.
 *
 * @param authToken Optional per-connection bearer token. When set (HTTP transport,
 *   one user per session) every tool call authenticates with this token instead of
 *   the locally stored/profile credentials used by the stdio transport.
 */
export function buildServer(authToken?: string): Server {
  const server = new Server(
    { name: "easyparcel", version: CLI_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: OPERATIONS.map((op) => ({
      name: mcpToolName(op),
      description: toolDescription(op),
      inputSchema: toolInputSchema(op),
      outputSchema: ENVELOPE_OUTPUT_SCHEMA,
      annotations: {
        title: `${op.group} ${op.command}`,
        readOnlyHint: !op.mutating,
        destructiveHint: Boolean(op.mutating),
        openWorldHint: true,
      },
    })),
  }));

  const byTool = new Map(OPERATIONS.map((op) => [mcpToolName(op), op]));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const op = byTool.get(request.params.name);
    if (!op) {
      return { content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const ctx = getContext();
    try {
      const body = op.body === "none" ? undefined : args;
      const env = await executeOperation(ctx, op, { body, accessToken: authToken });
      const status = effectiveStatus(env);
      const itemErrors = collectItemErrors(env);
      const isError = status >= 400;
      const summaryLines: string[] = [];
      if (isError) summaryLines.push(`API status ${status}${env.message ? `: ${env.message}` : ""}`);
      if (itemErrors.length) {
        summaryLines.push(`${itemErrors.length} batch item(s) failed:`);
        for (const e of itemErrors) summaryLines.push(`  - item ${e.index}: ${e.errors.join("; ")}`);
      }
      const text = (summaryLines.length ? summaryLines.join("\n") + "\n\n" : "") + JSON.stringify(env, null, 2);
      return {
        content: [{ type: "text", text }],
        structuredContent: env as Record<string, unknown>,
        isError,
      };
    } catch (e) {
      const msg = e instanceof CliError ? e.message : (e as Error).message;
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  });

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`EasyParcel MCP server running on stdio (${OPERATIONS.length} tools).`);
  // Keep the process alive until stdin closes.
  await new Promise<void>((resolve) => {
    process.stdin.on("close", resolve);
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });
}
