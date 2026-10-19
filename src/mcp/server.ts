import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { OPERATIONS, mcpToolName, mcpPrerequisiteText } from "../operations";
import type { Operation } from "../operations/types";
import { executeOperation } from "../cli/run";
import { prerequisiteHint } from "../cli/hints";
import { collectItemErrors, effectiveStatus } from "../core/envelope";
import { getContext } from "../core/context";
import { CliError } from "../core/errors";
import { targetErrorHint, validateAccountId, validateOrganizationId, ACCOUNT_HEADER, ORGANIZATION_HEADER } from "../core/target";
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

// Target parameters every tool accepts. They are popped from the arguments before the request
// body is built and sent as the X-Account-Id / X-Organization-Id headers instead.
const TARGET_PROPERTIES: Record<string, unknown> = {
  account_id: {
    type: ["string", "number"],
    description: "Shipping account to act on. List them with ep_account_list.",
  },
  organization_id: {
    type: "string",
    description: "Organization to act on (id or 6-letter ref). List them with ep_organization_list.",
  },
};

export function toolInputSchema(op: Operation): Record<string, unknown> {
  if (op.body === "none") {
    return { type: "object", properties: { ...TARGET_PROPERTIES }, additionalProperties: false };
  }
  const base: Record<string, unknown> = op.schema
    ? (structuredClone(op.schema) as Record<string, unknown>)
    : { type: "object", properties: {} };
  const props = base.properties && typeof base.properties === "object" ? (base.properties as Record<string, unknown>) : {};
  base.properties = { ...props, ...TARGET_PROPERTIES };
  base.additionalProperties = true; // the API may accept fields beyond our schema
  if (op.example !== undefined) base.examples = [op.example];
  return base;
}

/**
 * Split tool arguments into the request body (target params removed) and the target headers.
 * Throws a CliError (usage) on a malformed account_id / organization_id.
 */
export function splitTargetArgs(args: Record<string, unknown>): { rest: Record<string, unknown>; headers: Record<string, string> } {
  const { account_id, organization_id, ...rest } = args;
  const headers: Record<string, string> = {};
  if (account_id !== undefined && account_id !== null && account_id !== "") {
    headers[ACCOUNT_HEADER] = validateAccountId(account_id, "account_id");
  }
  if (organization_id !== undefined && organization_id !== null && organization_id !== "") {
    headers[ORGANIZATION_HEADER] = validateOrganizationId(organization_id, "organization_id");
  }
  return { rest, headers };
}

export interface BuildServerOptions {
  /** Called when a token-authed tool call gets an upstream 401 (hosted broker, decision S9). */
  onUnauthorized?: () => void;
  /** Test seam: replaces executeOperation. */
  execute?: typeof executeOperation;
}

export function toolDescription(op: Operation): string {
  const parts = [op.summary + "."];
  if (op.description) parts.push(op.description);
  parts.push(`Endpoint: ${op.method} /open_api/{version}/${op.path}.`);
  if (op.body !== "none") parts.push("The tool arguments ARE the JSON request body (except account_id / organization_id, which pick the target).");
  if (op.pagination) parts.push("Cursor-paginated; pass the cursor field to page.");
  if (op.docNote) parts.push(`Note: ${op.docNote}`);
  if (op.mutating) parts.push("MUTATING: this creates/cancels orders and may charge your wallet.");
  const prereq = mcpPrerequisiteText(op);
  if (prereq) parts.push(prereq);
  return parts.join(" ");
}

/**
 * Build an MCP Server exposing every EasyParcel operation as a tool.
 *
 * @param authToken Optional per-connection bearer token, or a getter returning the session's
 *   current one. When set (HTTP transport, one user per session) every tool call authenticates
 *   with it instead of the locally stored/profile credentials used by the stdio transport.
 */
export function buildServer(authToken?: string | (() => string | undefined), options: BuildServerOptions = {}): Server {
  const currentToken = typeof authToken === "function" ? authToken : () => authToken;
  const tokenAuthed = authToken !== undefined;
  const execute = options.execute ?? executeOperation;
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
      const { rest, headers } = splitTargetArgs(args);
      const body = op.body === "none" ? undefined : rest;
      const env = await execute(ctx, op, { body, accessToken: currentToken(), headers });
      const status = effectiveStatus(env);
      if (tokenAuthed && (env._http_status === 401 || status === 401)) options.onUnauthorized?.();
      const itemErrors = collectItemErrors(env);
      const isError = status >= 400;
      const summaryLines: string[] = [];
      if (isError) summaryLines.push(`API status ${status}${env.message ? `: ${env.message}` : ""}`);
      const hint = isError ? targetErrorHint(env, "mcp") : undefined;
      if (hint) summaryLines.push(hint.message);
      const edgeHint = prerequisiteHint(op, env, "mcp");
      if (edgeHint) summaryLines.push(edgeHint);
      if (itemErrors.length) {
        summaryLines.push(`${itemErrors.length} batch item(s) failed:`);
        for (const e of itemErrors) summaryLines.push(`  - item ${e.label ?? e.index}: ${e.errors.join("; ")}`);
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
