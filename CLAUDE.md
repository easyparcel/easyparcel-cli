See [AGENTS.md](AGENTS.md) for architecture, conventions, and how to extend this CLI.

Quick reference:
- Build: `npm run typecheck && npm run build` · Dev: `npm run dev -- <args>`
- The API surface is declared once in `src/operations/*.ts` and drives the CLI commands,
  the MCP server (`src/mcp/server.ts`), and `ep describe`. Add endpoints there.
- stdout = results only; diagnostics go to stderr (`src/core/logger.ts`).
