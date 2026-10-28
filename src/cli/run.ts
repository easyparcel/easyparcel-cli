import { apiRequest, buildUrl } from "../core/client";
import { paginateAll } from "../core/pagination";
import { collectItemErrors, effectiveStatus } from "../core/envelope";
import { CliError, ExitCode, exitCodeForStatus } from "../core/errors";
import { printEnvelope, printJson } from "../core/output";
import { log } from "../core/logger";
import { envelopeCode, targetErrorHint } from "../core/target";
import { getProfileCredentials, loadStore } from "../core/credentials";
import { decodeJwtPayload } from "../core/jwt";
import { cliCommand, targetScope } from "../operations";
import { prerequisiteHint } from "./hints";
import type { RuntimeContext } from "../core/context";
import type { Operation } from "../operations/types";
import type { Envelope } from "../core/types";

export interface RunInput {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  columns?: string[];
  /** Per-request bearer token (overrides stored/profile creds; used by the HTTP MCP server). */
  accessToken?: string;
  /** Extra request headers, e.g. X-Account-Id / X-Organization-Id from MCP tool arguments. */
  headers?: Record<string, string>;
}

/** Execute an operation and return the resulting envelope (no printing). Shared by CLI + MCP. */
export async function executeOperation(ctx: RuntimeContext, op: Operation, input: RunInput = {}): Promise<Envelope> {
  const body = op.body === "none" ? undefined : input.body;
  if (op.bodyRequired && (body === undefined || body === null)) {
    throw new CliError(
      `'${op.id}' requires a request body. Provide --data '<json>' (or --data @file.json, or --data - for stdin).`,
      ExitCode.USAGE,
    );
  }

  // Auto-paginate list endpoints when --page-all is set.
  if (op.pagination && ctx.page.all) {
    const baseBody = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    return paginateAll(ctx, {
      fetch: (cursor) =>
        apiRequest(ctx, {
          method: op.method,
          path: op.path,
          versioned: op.versioned !== false,
          auth: op.auth !== false,
          accessToken: input.accessToken,
          headers: input.headers,
          target: op.target !== false,
          query: input.query,
          body: { ...baseBody, ...(cursor ? { [op.pagination!.cursorField]: cursor } : {}) },
        }),
      nextCursor: op.pagination.nextCursor,
    });
  }

  return apiRequest(ctx, {
    method: op.method,
    path: op.path,
    versioned: op.versioned !== false,
    auth: op.auth !== false,
    accessToken: input.accessToken,
    headers: input.headers,
    target: op.target !== false,
    body,
    query: input.query,
  });
}

/** Shown on stdout for a failed call only for machines: explicit JSON, or stdout piped. */
function machineErrors(ctx: RuntimeContext): boolean {
  const jsonish = ctx.format === "json" || ctx.format === "pretty" || ctx.format === "ndjson";
  return (ctx.formatExplicit && jsonish) || !process.stdout.isTTY;
}

/** One friendly line for a failed call: `<message>[: <detail>] (<code>)`. Exported for tests. */
export function friendlyError(env: Envelope): string {
  const status = effectiveStatus(env);
  const raw = typeof env.message === "string" ? env.message.trim().replace(/[;:,\s]+$/, "") : "";
  const message = raw || `HTTP ${status}`;
  // Validation details: a list of messages, or { field: [messages] } from the API's validator.
  const data = env.data;
  let texts: string[] = [];
  if (Array.isArray(data)) texts = data.filter((x) => typeof x === "string");
  else if (data && typeof data === "object") {
    for (const v of Object.values(data as Record<string, unknown>)) {
      if (typeof v === "string") texts.push(v);
      else if (Array.isArray(v)) texts.push(...v.filter((x): x is string => typeof x === "string"));
    }
  } else if (typeof data === "string") texts = [data];
  texts = texts.map((t) => t.trim()).filter((t) => t && t !== message);
  const detail = texts.length ? texts.slice(0, 3).join("; ") + (texts.length > 3 ? ` (+${texts.length - 3} more)` : "") : "";
  const code = envelopeCode(env) ?? String(status);
  return `${message}${detail ? `: ${detail}` : ""} (${code})`;
}

/**
 * Print the envelope and set the process exit code based on status / item errors.
 * A failed call prints ONE friendly stderr line (plus a prerequisite hint when the error names a
 * field another operation supplies); the raw envelope goes to stdout only for machines.
 */
export function reportEnvelope(ctx: RuntimeContext, env: Envelope, columns?: string[], op?: Operation): void {
  const status = effectiveStatus(env);
  if (status >= 400) {
    // Keep the chosen format (ndjson stays one line per row, csv/table stay csv/table).
    if (machineErrors(ctx)) printEnvelope(env, ctx, { columns });
    const target = targetErrorHint(env, "cli");
    if (target) {
      process.exitCode = target.usage ? ExitCode.USAGE : exitCodeForStatus(status);
      log.error(target.message);
    } else {
      process.exitCode = exitCodeForStatus(status);
      log.error(friendlyError(env));
    }
    const hint = op ? prerequisiteHint(op, env, "cli") : undefined;
    if (hint) log.info(hint);
    log.debug(`envelope: ${JSON.stringify(env)}`);
    return;
  }

  printEnvelope(env, ctx, { columns });
  const itemErrors = collectItemErrors(env);
  if (itemErrors.length) {
    log.warn(`${itemErrors.length} batch item(s) failed:`);
    for (const e of itemErrors) {
      log.warn(`  - item ${e.label ?? e.index}${e.status ? ` [${e.status}]` : ""}: ${e.errors.join("; ") || "(no detail)"}`);
    }
    const hint = op ? prerequisiteHint(op, env, "cli") : undefined;
    if (hint) log.info(hint);
    if (ctx.failOnItemError) process.exitCode = ExitCode.ITEM_ERRORS;
  }
}

/**
 * A target flag the operation does not read: --organization on an account-scoped call, or
 * --account on an organization-scoped one. It is not sent; returns the context to call with and
 * the warning to print once the call is done.
 */
export function ignoredTargetFlag(
  ctx: RuntimeContext,
  op: Operation,
): { ctx: RuntimeContext; warn?: (env: Envelope) => string } {
  const scope = targetScope(op);
  const command = `\`${cliCommand(op.id)}\``;
  if (scope === "account" && ctx.organizationFromFlag && ctx.organizationId) {
    const org = ctx.organizationId;
    return {
      ctx: { ...ctx, organizationId: undefined },
      warn: (env) => {
        const ok = effectiveStatus(env) < 400;
        const account = ctx.accountId ?? tokenAccountId(ctx);
        const tail = ok ? (account !== undefined ? `answered by account ${account}` : "answered by the token's own account") : "it was not sent";
        return `--organization ${org} is ignored by ${command} (it acts on a shipping account); ${tail}.`;
      },
    };
  }
  if (scope === "organization" && ctx.accountFromFlag && ctx.accountId) {
    const account = ctx.accountId;
    return {
      ctx: { ...ctx, accountId: undefined },
      warn: (env) => {
        const ok = effectiveStatus(env) < 400;
        const tail = ok ? (ctx.organizationId ? `answered by organization ${ctx.organizationId}` : "answered by your default organization") : "it was not sent";
        return `--account ${account} is ignored by ${command} (it acts on an organization); ${tail}.`;
      },
    };
  }
  return { ctx };
}

/** The account an account-bound token carries (from the stored index or the JWT), if any. */
function tokenAccountId(ctx: RuntimeContext): string | undefined {
  try {
    const creds = getProfileCredentials(ctx.profile);
    const id = creds.account_id ?? decodeJwtPayload(creds.access_token)?.user?.account_id;
    return id === undefined || id === null || id === "" ? undefined : String(id);
  } catch {
    return undefined;
  }
}

/** Full CLI execution: dry-run preview for mutating ops, otherwise call + report. */
export async function runOperation(ctx: RuntimeContext, op: Operation, input: RunInput = {}): Promise<void> {
  if (op.mutating && ctx.dryRun) {
    printJson({
      dry_run: true,
      operation: op.id,
      method: op.method,
      url: buildUrl(ctx, op.path, op.versioned !== false),
      body: input.body ?? null,
    });
    log.info("dry-run: request not sent.");
    return;
  }
  const { ctx: callCtx, warn } = ignoredTargetFlag(ctx, op);
  const env = await executeOperation(callCtx, op, input);
  if (warn) log.warn(warn(env));
  // Listing commands render a fixed human table on a terminal (or with --format table|csv);
  // JSON stays the default when piped, so agents and scripts see the full envelope.
  const human =
    ctx.format === "table" || ctx.format === "csv" || (!ctx.formatExplicit && Boolean(process.stdout.isTTY));
  if (op.humanTable && human && effectiveStatus(env) < 400 && env.data !== null && typeof env.data === "object") {
    const format = ctx.format === "csv" ? "csv" : "table";
    const rows = op.humanTable.rows(env.data, { defaultAccountId: profileDefaultAccount(ctx) });
    reportEnvelope({ ...ctx, format }, { ...env, data: rows }, op.humanTable.columns, op);
    return;
  }
  reportEnvelope(ctx, env, input.columns, op);
}

/** The profile's default account (`ep account use`), else the account its token is bound to. */
function profileDefaultAccount(ctx: RuntimeContext): string | undefined {
  const rec = loadStore().profiles[ctx.profile];
  const id = rec?.default_account_id ?? rec?.account_id;
  return id === undefined || id === null || id === "" ? undefined : String(id);
}
