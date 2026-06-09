# AGENTS.md — EasyParcel CLI

Guidance for AI agents and contributors working on **this CLI's source** (not for
end-users driving the CLI — that's in `skills/` and `README.md`).

## What this is

A TypeScript/Node.js CLI for the EasyParcel Open API (v2026-03), bundled to a single
ESM file with `tsup`. Binaries: `easyparcel` and `ep`. Built for AI-agent use: JSON
output, stable exit codes, a self-describing operation catalog, AI Skills, and an MCP server.

## Commands

```bash
npm run dev -- <args>   # run from source via tsx
npm run typecheck       # tsc --noEmit (run before building)
npm run build           # bundle src/index.ts -> dist/index.js (shebang added by tsup banner)
npm test                # vitest
npm link                # expose `ep` globally for manual testing
```

## Architecture

```
src/
  index.ts            Entry: builds the commander program, registers everything,
                      preAction hook -> buildContext(), top-level error handling.
  core/               Runtime-agnostic library (no commander):
    types.ts          Shared types (Envelope, configs, tokens).
    context.ts        RuntimeContext + buildContext() — resolves flag>env>config>default.
    config.ts         ~/.easyparcel/config.json (+ DEFAULT_* constants).
    credentials.ts    ~/.easyparcel/credentials.json (0600) + env overrides + profiles.
    oauth.ts          PKCE, auth URL, token/refresh/client_credentials, loopback server, openUrl.
    tokens.ts         getValidAccessToken / doRefresh / expiry handling / maybePersist.
    http.ts           Low-level node:http(s) request (handles GET-with-body; fetch can't).
    client.ts         apiRequest(): version prefix, bearer auth, 401 refresh-retry, 429/network backoff.
    envelope.ts       Parse status; collectItemErrors() for batch per-item failures.
    output.ts         Formatters: json | pretty | table | ndjson | csv; color.
    pagination.ts     paginateAll() cursor walker.
    errors.ts         CliError + ExitCode map.
  operations/         SINGLE SOURCE OF TRUTH for the API surface (drives CLI + MCP):
    types.ts          Operation interface + schema helpers (str/num/obj/...).
    shipment.ts courier.ts ondemand.ts account.ts einvoice.ts
    index.ts          OPERATIONS[], getOperation(), mcpToolName().
  cli/                Commander wiring:
    global.ts         addGlobalOptions(), buildLongHelp().
    run.ts            executeOperation() (shared w/ MCP), reportEnvelope(), runOperation() (+dry-run).
    register.ts       Turns OPERATIONS into grouped commands + top-level aliases.
    input.ts          resolveData(): --data string | @file | - (stdin).
    auth.ts api.ts config.ts describe.ts reference.ts shortcuts.ts mcp.ts
  mcp/server.ts       Stdio MCP server; one tool per operation, reusing executeOperation().
  reference/index.ts  State codes (ISO + e-invoice numeric), status tables, ID prefixes.
```

### Key design rules
- **Operations are declarative.** To add/modify an endpoint, edit the relevant
  `src/operations/*.ts` — you get the CLI command, MCP tool, `ep describe` entry and
  help for free. Avoid hand-writing per-endpoint command files.
- **stdout is for results only** (machine-readable). All logs/prompts go to **stderr**
  via `core/logger.ts`. Never `console.log` diagnostics.
- **Don't throw on API errors.** `apiRequest` returns the envelope; `reportEnvelope`
  decides the exit code. Only throw `CliError` for usage/auth/network problems.
- **Mutating ops** set `mutating: true` → they gain `--dry-run` and MCP `destructiveHint`.
- **Precedence**: flag > env > config > default, centralized in `buildContext`.
- Global flags are duplicated on leaf commands (without defaults) so they parse before
  OR after the subcommand; the preAction hook reads `optsWithGlobals()`.

### Conventions
- Files: kebab-case modules; PascalCase types; camelCase functions/vars (TS idiom — note
  this differs from the snake_case used in `ep_internal_api`, which is a different codebase).
- Keep `CLI_VERSION` in `src/core/version.ts` in sync with `package.json`.
- The canonical endpoint paths follow the **Postman collection**, not the prose docs
  (they disagree); see comments in `operations/*` and `README.md` caveats.

## Adding an operation (example)
1. Add an `Operation` to the right `src/operations/<group>.ts` (id, command, method, path,
   `body`, `schema`, `example`, `mutating?`, `pagination?`).
2. `npm run typecheck && npm run build`.
3. Verify: `ep describe <group>.<command>`, `ep <group> <command> --help`, and that it
   appears in the MCP `tools/list`.

## Testing without real orders
- `--dry-run` previews mutating requests offline.
- A fake `EASYPARCEL_ACCESS_TOKEN` exercises the full HTTP path (server returns 401).
- Set `EASYPARCEL_CONFIG_DIR` to an isolated dir in tests.
