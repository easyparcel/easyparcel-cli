import { Command } from "commander";
import { addGlobalOptions } from "./global";
import { runMcpServer } from "../mcp/server";
import { runHttpMcpServer } from "../mcp/http";
import { CliError, ExitCode } from "../core/errors";

/** `ep mcp` — run an MCP server (stdio by default, or Streamable HTTP) exposing every operation as a tool. */
export function registerMcp(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Run an MCP (Model Context Protocol) server exposing every operation as a tool")
    .option("--http", "Serve over Streamable HTTP instead of stdio (for remote/ChatGPT connectors)")
    .option("--port <n>", "HTTP port (with --http)", "8790")
    .option("--host <host>", "HTTP bind address (with --http)", "127.0.0.1")
    .option("--path <path>", "HTTP endpoint path (with --http)", "/mcp")
    .option("--require-auth", "Reject HTTP requests without an Authorization: Bearer token")
    .option("--oauth", "Enable the OAuth 2.1 authorization-server proxy for ChatGPT connectors (implies --require-auth)")
    .option("--public-url <url>", "Public HTTPS base URL clients reach (e.g. https://mcp.easyparcel.com); used in OAuth metadata")
    .option("--ep-client-id <id>", "EasyParcel OAuth client id the proxy authenticates as upstream (per-source attribution; defaults to EASYPARCEL_CLIENT_ID or the built-in CLI client)")
    .option("--ep-client-secret <secret>", "EasyParcel OAuth client secret, if the upstream app is confidential");
  addGlobalOptions(mcp);
  mcp.addHelpText(
    "after",
    [
      "",
      "Stdio (Claude Desktop / Claude Code / Cursor):",
      '  { "mcpServers": { "easyparcel": { "command": "easyparcel", "args": ["mcp"] } } }',
      "",
      "Streamable HTTP (remote / ChatGPT app connector):",
      "  ep mcp --http --host 0.0.0.0 --port 8790 --oauth --public-url https://mcp.example.com",
      "  → connector URL: https://mcp.example.com/mcp   (ChatGPT runs the OAuth login flow)",
      "  Or, simple pre-issued token instead of OAuth:",
      "  ep mcp --http --require-auth   (clients send Authorization: Bearer <token>)",
      "",
      "Authenticate first (ep auth login) or pass tokens via EASYPARCEL_ACCESS_TOKEN.",
      "Over HTTP, each client's own bearer token is used per session.",
    ].join("\n"),
  );
  mcp.action(async (opts) => {
    if (!opts.http) {
      await runMcpServer();
      return;
    }
    const port = Number(opts.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new CliError(`Invalid --port '${opts.port}'.`, ExitCode.USAGE);
    }
    await runHttpMcpServer({
      port,
      host: opts.host,
      path: opts.path,
      requireAuth: Boolean(opts.requireAuth),
      oauth: Boolean(opts.oauth),
      publicUrl: opts.publicUrl,
      epClientId: opts.epClientId,
      epClientSecret: opts.epClientSecret,
    });
  });
}
