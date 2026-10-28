---
name: easyparcel-shared
description: Core conventions for driving the EasyParcel CLI (`ep` / `easyparcel`) — authentication, JSON request bodies, output formats, batch error handling, exit codes, and self-describing operations. Reference this whenever using any `ep` command to ship, track, quote, or manage EasyParcel logistics.
---

# EasyParcel CLI — Core usage

`ep` (alias of `easyparcel`) is a command-line client for the EasyParcel Open API
(courier shipping for Malaysia & Singapore). It is designed for AI agents: every
command prints JSON to stdout, diagnostics go to stderr, and exit codes are stable.

## Three layers — pick the right one
- **Shortcuts** (fast, friendly): `ep +rates --from 11950 --to 55100 --weight 1`, `ep +track <awb...>`, `ep +ship ...`
- **Commands** (1:1 with endpoints): `ep <group> <command> --data '<json>'` — e.g. `ep shipment quote`, `ep shipment submit`, `ep ondemand order`. Convenience top-level aliases exist: `ep quote`, `ep track`, `ep wallet`, `ep ship`.
- **Raw API** (anything): `ep api POST shipment/quotations --data '<json>'`

## Discover operations (do this first if unsure)
- `ep describe` → JSON list of every operation (id, method, path, whether it mutates, MCP tool name).
- `ep describe shipment.quote` → full detail incl. the request-body **JSON Schema** and an example.

Use `ep describe <id>` to learn exactly what fields a command needs — do not guess.

**Fetch ids first, never guess them.** Every operation lists its `prerequisites`: the request
field, the operation whose response supplies it, and the response field — in `ep describe`, in
`ep <group> <command> --help` ("Before you call this"), and in each MCP tool description. E.g.
`shipment[].service_id ← ep shipment quote ([].quotations[].courier.service_id)`,
`awb_numbers ← ep shipment list ([].awb_number)`, `booking_id ← ep ondemand list ([].booking_id)`,
`account_id ← ep account list` when the login covers all accounts. When a call fails because
of such a field, stderr adds `hint: <field> comes from \`ep …\` — run that first.`

## Authentication
- Interactive: `ep login` (browser sign-in, result on localhost:8788) or `ep login --device` (a code approved on any device). Check with `ep auth status`. Running `ep login` again while signed in only reports the session; `--force` signs in again.
- Headless / CI / agents: set `EASYPARCEL_ACCESS_TOKEN` (and optionally `EASYPARCEL_REFRESH_TOKEN`); the CLI auto-refreshes. These env vars override stored credentials and are never written to disk.
- Not authenticated → exit code **3** with a clear message.

## Choosing the account (sign in once, name the target per call)
One login (choose "All my shipping accounts" on approval) or a personal access token reaches
every account the person owns. `ep auth status` shows `target_mode: "identity"` for such a login.
1. `ep account list` → `account_id`, `name`, `account_type`, `base_country`, `token_usable`.
2. Pass `--account <id>` on any command, or store a default: `ep account use <id>` (`--clear` drops it).
   Precedence: `--account` > `EASYPARCEL_ACCOUNT_ID` > profile default.
3. Organizations (WhatsApp, AI agent): `ep org list`, then `--organization <id|6-letter ref>`,
   `EASYPARCEL_ORGANIZATION_ID`, or `ep org use <id|ref>`.
- *"This login covers all your accounts. Name one…"* (exit **2**) → the call needs an account; do steps 1–2.
- `ACCOUNT_FORBIDDEN` / `ACCOUNT_OWNER_REQUIRED` / `ORGANIZATION_FORBIDDEN` (exit **9**, forbidden) → pick another id from the list.
- MCP tools: call `ep_account_list` / `ep_organization_list`, then pass `account_id` / `organization_id` on any tool.
- `ep login --all` and `ep auth sync` (one profile per account) are deprecated; use `--account`.

## Passing request bodies (`--data`)
Commands that take a body accept JSON three ways:
- `--data '{"...":...}'` — inline (mind your shell's quoting).
- `--data @path/to/body.json` — from a file (**preferred for complex payloads**).
- `--data -` — from stdin (great for piping generated JSON).

When constructing a non-trivial order, write the JSON to a temp file and use `--data @file` to avoid shell-quoting problems.

## Output
- Default: the full response envelope `{ "status_code", "request_id", "message", "data" }` as pretty JSON. Listings (`account list`, `org list`, `wallet`, `shipment parcel-categories`) show a table on a terminal; piped output stays JSON.
- Errors: one line on stderr (`error: <message> (<code>)`, plus a `hint:` line when a prerequisite applies). The JSON envelope is printed on stdout only when stdout is not a terminal or `--format json` is given, so scripts and agents still get it; `-v` adds it to stderr.
- `--data-only` → print just `data`. `--format table|csv|ndjson|json`. `ndjson` emits one `data` item per line (good for piping).

## Batch semantics — IMPORTANT
Batch endpoints (quote, submit, cancel, track, insurance) return **HTTP 200 even when some items fail**. Always inspect each element of `data[]`:
- `data[i].status` is `"success"`, `"error"`, or `"not_found"`.
- `data[i].errors` is an array of messages.
The CLI prints a per-item failure summary to stderr. Add `--fail-on-item-error` to make the process exit **7** when any item fails (useful in scripts).

## Mutating commands
`shipment submit`, `shipment cancel`, `ondemand order`, `ondemand cancel`, `einvoice submit` spend wallet credit or change state. Preview first with `--dry-run` (prints the exact request, sends nothing).

## Exit codes
`0` ok · `2` usage error · `3` not signed in · `4` not found · `5` bad input · `6` rate-limited · `7` batch item errors · `8` network · `9` forbidden (signed in, but not allowed: scope, owner-only or another account).

## Endpoint / version notes
- Base URL `https://api.easyparcel.com`; version prefix `/open_api/2026-03/` is added automatically (override with `--api-version` or `--base-url`).
- A few endpoints are **GET-with-body** (`courier list`, `shipment coupon-list`, `ondemand coupon-list`, `shipment bulk-awbs`, `address search`) — just pass `--data`; the CLI handles it.
- The CLI talks to the live EasyParcel API; there is no sandbox. Use `--dry-run` before anything that spends credit.
- Couriers are available for `MY` and `SG`.
