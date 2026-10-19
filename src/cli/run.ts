import { apiRequest, buildUrl } from "../core/client";
import { paginateAll } from "../core/pagination";
import { collectItemErrors, effectiveStatus } from "../core/envelope";
import { CliError, ExitCode, exitCodeForStatus } from "../core/errors";
import { printEnvelope, printJson } from "../core/output";
import { log } from "../core/logger";
import { targetErrorHint } from "../core/target";
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

/**
 * Print the envelope and set the process exit code based on status / item errors. With `op`, a
 * failure whose error names a field another operation supplies gets one `hint:` line.
 */
export function reportEnvelope(ctx: RuntimeContext, env: Envelope, columns?: string[], op?: Operation): void {
  printEnvelope(env, ctx, { columns });

  const status = effectiveStatus(env);
  const edgeHint = op ? prerequisiteHint(op, env, "cli") : undefined;
  if (status >= 400) {
    const hint = targetErrorHint(env, "cli");
    if (hint) {
      process.exitCode = hint.usage ? ExitCode.USAGE : exitCodeForStatus(status);
      log.error(hint.message);
      if (edgeHint) log.info(edgeHint);
      return;
    }
    process.exitCode = exitCodeForStatus(status);
    log.warn(`API status ${status}${env.message ? `: ${env.message}` : ""}`);
    if (edgeHint) log.info(edgeHint);
    return;
  }

  const itemErrors = collectItemErrors(env);
  if (itemErrors.length) {
    log.warn(`${itemErrors.length} batch item(s) failed:`);
    for (const e of itemErrors) {
      log.warn(`  - item ${e.index}${e.status ? ` [${e.status}]` : ""}: ${e.errors.join("; ") || "(no detail)"}`);
    }
    if (edgeHint) log.info(edgeHint);
    if (ctx.failOnItemError) process.exitCode = ExitCode.ITEM_ERRORS;
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
  const env = await executeOperation(ctx, op, input);
  // Listing commands render a fixed human table on a terminal (or with --format table|csv);
  // JSON stays the default when piped, so agents and scripts see the full envelope.
  const human =
    ctx.format === "table" || ctx.format === "csv" || (!ctx.formatExplicit && Boolean(process.stdout.isTTY));
  if (op.humanTable && human && effectiveStatus(env) < 400 && Array.isArray(env.data)) {
    const format = ctx.format === "csv" ? "csv" : "table";
    reportEnvelope({ ...ctx, format }, { ...env, data: op.humanTable.rows(env.data) }, op.humanTable.columns, op);
    return;
  }
  reportEnvelope(ctx, env, input.columns, op);
}
