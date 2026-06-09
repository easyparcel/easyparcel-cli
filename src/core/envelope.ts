import type { Envelope } from "./types";

export interface ItemError {
  index: number;
  status?: string;
  errors: string[];
  input?: unknown;
}

function normalizeErrors(e: unknown): string[] {
  if (!e) return [];
  if (Array.isArray(e)) return e.map((x) => String(x).trim()).filter(Boolean);
  if (typeof e === "string") return [e.trim()];
  if (typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (Array.isArray(obj.errors)) return normalizeErrors(obj.errors);
    return [JSON.stringify(e)];
  }
  return [String(e)];
}

/**
 * Inspect a batch response for per-item failures.
 *
 * EasyParcel batch endpoints (quotations, submit_orders, cancel, tracking,
 * insurance) return HTTP 200 even when individual items fail. Each element
 * carries a `status` ("success" | "error" | "not_found") and/or an `errors`
 * array. This surfaces those so the runner can warn / set an exit code.
 */
export function collectItemErrors(env: Envelope): ItemError[] {
  const out: ItemError[] = [];
  const data: unknown = env.data;
  if (!Array.isArray(data)) return out;

  data.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const obj = item as Record<string, unknown>;
    const status = typeof obj.status === "string" ? obj.status : undefined;
    const errs = normalizeErrors(obj.errors);
    const failed = status === "error" || status === "not_found" || errs.length > 0;
    if (failed) {
      out.push({
        index,
        status,
        errors: errs.length ? errs : obj.message ? [String(obj.message)] : [],
        input: obj.input,
      });
    }
  });
  return out;
}

/** Effective status: prefer the envelope's status_code, fall back to HTTP. */
export function effectiveStatus(env: Envelope): number {
  return typeof env.status_code === "number" ? env.status_code : (env._http_status ?? 0);
}

export function isHardError(env: Envelope): boolean {
  return effectiveStatus(env) >= 400;
}
