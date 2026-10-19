import { cliCommand, getOperation, mcpToolName, paramLeaf, prerequisitesOf } from "../operations";
import type { Operation, Prerequisite } from "../operations/types";
import { collectItemErrors, effectiveStatus } from "../core/envelope";
import type { Envelope } from "../core/types";

// Statuses whose message can name a bad or missing input (validation / not found).
const HINT_STATUSES = new Set([400, 404, 422]);

/** Every string in a value (depth-limited), for scanning error messages and error fields. */
function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || v === null || v === undefined) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "input") continue; // echoed request, not an error
      out.push(k);
      strings(x, out, depth + 1);
    }
  }
  return out;
}

/** The text of a failed call: message, error fields and per-item errors. */
function errorText(env: Envelope): string {
  const parts = [env.message, (env as Record<string, unknown>).errors, (env as Record<string, unknown>).error];
  if (effectiveStatus(env) >= 400) parts.push(env.data);
  for (const e of collectItemErrors(env)) parts.push(e.errors);
  return strings(parts).join("\n");
}

/** The first edge (target edges excluded: those have their own hints) whose param the error names. */
export function matchPrerequisite(op: Operation, env: Envelope): Prerequisite | undefined {
  const status = effectiveStatus(env);
  const failed = HINT_STATUSES.has(status) || (status < 400 && collectItemErrors(env).length > 0);
  if (!failed) return undefined;
  const text = errorText(env);
  if (!text) return undefined;
  for (const edge of prerequisitesOf(op)) {
    if (edge.param === "account_id" || edge.param === "organization_id") continue;
    const leaf = paramLeaf(edge.param);
    // The API's validator writes field names with spaces ("The shipment number field is
    // required", "shipment 0 service id"), so `_` in the leaf also matches a space. The boundary
    // check keeps `ondemand_service_id` from matching `service_id`.
    const pattern = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, "[_ ]");
    if (new RegExp(`(^|[^A-Za-z0-9_])${pattern}($|[^A-Za-z0-9_])`, "i").test(text)) return edge;
  }
  return undefined;
}

/** One hint line for a failed call whose error names a param with an edge, else undefined. */
export function prerequisiteHint(op: Operation, env: Envelope, surface: "cli" | "mcp" = "cli"): string | undefined {
  const edge = matchPrerequisite(op, env);
  if (!edge) return undefined;
  const leaf = paramLeaf(edge.param);
  if (surface === "mcp") {
    const from = getOperation(edge.from);
    return `hint: ${leaf} comes from ${from ? mcpToolName(from) : edge.from}${edge.field ? ` (${edge.field})` : ""} — call that first.`;
  }
  return `hint: ${leaf} comes from \`${cliCommand(edge.from)}\` — run that first.`;
}
