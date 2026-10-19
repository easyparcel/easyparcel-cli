import { OPERATIONS, mcpToolName } from "../operations";
import type { Operation } from "../operations/types";

/**
 * Comma-separated allow-list of the operations an MCP server exposes, by operation id
 * (`shipment.quote`) or tool name (`ep_shipment_quote`). Unset = every operation.
 *
 * Used by the hosted brokers to narrow a connector's tool surface, e.g. the ChatGPT broker runs
 * with the read-only set `shipment.quote,shipment.list,shipment.details,shipment.track,
 * shipment.insurance-quote,courier.list,courier.dropoff-points`. Ported from the 0.1.11 broker
 * image (2026-09-01), whose source never reached this repo.
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
