import { cliCommand, getOperation, mcpToolName, paramLeaf, prerequisitesOf } from "../operations";
import type { Operation, Prerequisite } from "../operations/types";
import { collectItemErrors, effectiveStatus } from "../core/envelope";
import type { Envelope } from "../core/types";

// Statuses whose message can name a bad or missing input (validation / not found).
const HINT_STATUSES = new Set([400, 404, 422]);

function stringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A validator map: { field: [messages] } (or { field: "message" }). */
function isValidatorMap(v: unknown): v is Record<string, string | string[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const values = Object.values(v as Record<string, unknown>);
  return values.length > 0 && values.every((x) => typeof x === "string" || (Array.isArray(x) && x.every((y) => typeof y === "string")));
}

/**
 * The text of a failed call: message, error fields, validator maps (keys = field names) and
 * per-item errors. Echoed request objects are never scanned: their keys (sender.point_code,
 * receiver, …) are present on every failed shipment and would name the wrong prerequisite.
 */
function errorText(env: Envelope): string {
  const raw = env as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof env.message === "string") parts.push(env.message);
  parts.push(...stringList(raw.errors), ...stringList(raw.error));
  if (isValidatorMap(raw.errors)) for (const [k, v] of Object.entries(raw.errors)) parts.push(k, ...stringList(v));
  if (effectiveStatus(env) >= 400) {
    const data = env.data;
    parts.push(...stringList(data));
    if (isValidatorMap(data)) for (const [k, v] of Object.entries(data)) parts.push(k, ...stringList(v));
  }
  for (const e of collectItemErrors(env)) parts.push(...e.errors);
  return parts.join("\n");
}

/**
 * The first hintable edge whose param the error names. Not hintable: the target edges (they
 * have their own hints), edges without a field (a check to run, not a value to copy) and edges
 * marked `hint: false` (the caller's own values, like an address).
 */
export function matchPrerequisite(op: Operation, env: Envelope): Prerequisite | undefined {
  const status = effectiveStatus(env);
  const failed = HINT_STATUSES.has(status) || (status < 400 && collectItemErrors(env).length > 0);
  if (!failed) return undefined;
  const text = errorText(env);
  if (!text) return undefined;
  for (const edge of prerequisitesOf(op)) {
    if (edge.param === "account_id" || edge.param === "organization_id") continue;
    if (!edge.field || edge.hint === false) continue;
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
