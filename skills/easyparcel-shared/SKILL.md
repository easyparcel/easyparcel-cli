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

## Authentication
- Interactive: `ep auth login` (browser OAuth2 + PKCE). Check with `ep auth status`.
- Headless / CI / agents: set `EASYPARCEL_ACCESS_TOKEN` (and optionally `EASYPARCEL_REFRESH_TOKEN`); the CLI auto-refreshes. These env vars override stored credentials and are never written to disk.
- Not authenticated → exit code **3** with a clear message.

## Passing request bodies (`--data`)
Commands that take a body accept JSON three ways:
- `--data '{"...":...}'` — inline (mind your shell's quoting).
- `--data @path/to/body.json` — from a file (**preferred for complex payloads**).
- `--data -` — from stdin (great for piping generated JSON).

When constructing a non-trivial order, write the JSON to a temp file and use `--data @file` to avoid shell-quoting problems.

## Output
- Default: the full response envelope `{ "status_code", "request_id", "message", "data" }` as pretty JSON.
- `--data-only` → print just `data`. `--format table|csv|ndjson|json`. `ndjson` emits one `data` item per line (good for piping).

## Batch semantics — IMPORTANT
Batch endpoints (quote, submit, cancel, track, insurance) return **HTTP 200 even when some items fail**. Always inspect each element of `data[]`:
- `data[i].status` is `"success"`, `"error"`, or `"not_found"`.
- `data[i].errors` is an array of messages.
The CLI prints a per-item failure summary to stderr. Add `--fail-on-item-error` to make the process exit **7** when any item fails (useful in scripts).

## Mutating commands
`shipment submit`, `shipment cancel`, `ondemand order`, `ondemand cancel`, `einvoice submit` spend wallet credit or change state. Preview first with `--dry-run` (prints the exact request, sends nothing).

## Exit codes
`0` ok · `2` usage error · `3` auth · `4` not found · `5` validation · `6` rate-limited · `7` batch item errors · `8` network.

## Endpoint / version notes
- Base URL `https://api.easyparcel.com`; version prefix `/open_api/2026-03/` is added automatically (override with `--api-version` or `--base-url`).
- A few endpoints are **GET-with-body** (`courier list`, `shipment coupon-list`, `ondemand coupon-list`) — just pass `--data`; the CLI handles it.
- Couriers are available for `MY` and `SG`.
