import { OPERATIONS, mcpToolName, targetScope } from "../operations";
import type { Operation, TargetScope } from "../operations/types";

/**
 * Comma-separated allow-list of the operations an MCP server exposes, by operation id
 * (`shipment.quote`) or tool name (`ep_shipment_quote`). Unset = every operation.
 *
 * Used by the hosted brokers to narrow a connector's tool surface, e.g. the ChatGPT broker runs
 * with the read-only set `shipment.quote,shipment.list,shipment.details,shipment.track,
 * shipment.insurance-quote,courier.list,courier.dropoff-points,account.list`. Ported from the
 * 0.1.11 broker image (2026-09-01), whose source never reached this repo.
 */
export const MCP_ALLOWED_OPERATIONS_ENV = "EP_MCP_ALLOWED_OPERATIONS";

/** Resolve the operations the MCP server should expose, honouring EP_MCP_ALLOWED_OPERATIONS. */
export function getMcpOperations(env: NodeJS.ProcessEnv = process.env): Operation[] {
  const raw = env[MCP_ALLOWED_OPERATIONS_ENV]?.trim();
  if (!raw) return OPERATIONS;
  const requested = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!requested.length) {
    throw new Error(`${MCP_ALLOWED_OPERATIONS_ENV} must contain at least one operation id.`);
  }
  const byId = new Map(OPERATIONS.map((op) => [op.id, op]));
  const byToolName = new Map(OPERATIONS.map((op) => [mcpToolName(op), op]));
  const selected: Operation[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const name of requested) {
    const op = byId.get(name) ?? byToolName.get(name);
    if (!op) {
      unknown.push(name);
      continue;
    }
    if (!seen.has(op.id)) {
      seen.add(op.id);
      selected.push(op);
    }
  }
  if (unknown.length) {
    throw new Error(
      `${MCP_ALLOWED_OPERATIONS_ENV} contains unknown operation(s): ${unknown.join(", ")}. Use ids from \`ep describe\`.`,
    );
  }
  if (!selected.length) {
    throw new Error(`${MCP_ALLOWED_OPERATIONS_ENV} resolved to an empty tool surface.`);
  }
  return selected;
}

const TARGET_LISTINGS: Record<TargetScope, string> = { account: "account.list", organization: "organization.list" };

/**
 * The listings a tool surface leaves out although its tools need them: an all-accounts sign-in
 * must pass account_id to every account-scoped tool, and only account.list says which ids exist
 * (organization.list likewise). Reported, never added: the allow-list stays exactly what it names.
 */
export function missingTargetListings(operations: Operation[]): string[] {
  const exposed = new Set(operations.map((op) => op.id));
  const scopes = new Set(operations.map((op) => targetScope(op)));
  return (Object.keys(TARGET_LISTINGS) as TargetScope[])
    .filter((scope) => scopes.has(scope) && !exposed.has(TARGET_LISTINGS[scope]))
    .map((scope) => TARGET_LISTINGS[scope]);
}

/** The startup warning for a surface missing a listing its tools need, or undefined. */
export function missingTargetListingsWarning(operations: Operation[]): string | undefined {
  const missing = missingTargetListings(operations);
  if (!missing.length) return undefined;
  const params = missing.map((id) => id.replace(/\.list$/, "_id"));
  return (
    `${MCP_ALLOWED_OPERATIONS_ENV} leaves out ${missing.join(", ")}: an all-accounts sign-in on this server ` +
    `cannot discover the ${params.join(" / ")} its tools need. Add ${missing.join(",")} to the list.`
  );
}
