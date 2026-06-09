import { apiRequest, buildUrl } from "../core/client";
import { paginateAll } from "../core/pagination";
import { collectItemErrors, effectiveStatus } from "../core/envelope";
import { CliError, ExitCode, exitCodeForStatus } from "../core/errors";
import { printEnvelope, printJson } from "../core/output";
import { log } from "../core/logger";
import type { RuntimeContext } from "../core/context";
import type { Operation } from "../operations/types";
import type { Envelope } from "../core/types";

export interface RunInput {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  columns?: string[];
  /** Per-request bearer token (overrides stored/profile creds; used by the HTTP MCP server). */
  accessToken?: string;
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
    body,
    query: input.query,
  });
}

/** Print the envelope and set the process exit code based on status / item errors. */
export function reportEnvelope(ctx: RuntimeContext, env: Envelope, columns?: string[]): void {
  printEnvelope(env, ctx, { columns });

  const status = effectiveStatus(env);
  if (status >= 400) {
    process.exitCode = exitCodeForStatus(status);
    log.warn(`API status ${status}${env.message ? `: ${env.message}` : ""}`);
    return;
  }

  const itemErrors = collectItemErrors(env);
  if (itemErrors.length) {
    log.warn(`${itemErrors.length} batch item(s) failed:`);
    for (const e of itemErrors) {
      log.warn(`  - item ${e.index}${e.status ? ` [${e.status}]` : ""}: ${e.errors.join("; ") || "(no detail)"}`);
    }
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
  reportEnvelope(ctx, env, input.columns);
}
