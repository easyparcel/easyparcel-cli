import type { HttpMethod } from "../core/client";
import type { Envelope } from "../core/types";

export type JSONSchema = Record<string, unknown>;

export type OperationGroup = "shipment" | "courier" | "ondemand" | "account" | "organization" | "einvoice" | "address";

/**
 * Where a request field comes from: another operation whose response carries the value.
 * Agents read these edges (help, `ep describe`, MCP tool descriptions, error hints) to fetch
 * an id first instead of guessing it.
 */
export interface Prerequisite {
  /** The request field (dotted path, `[]` for array items) or target param (`account_id` /
   *  `organization_id`) that needs a fetched value, e.g. "shipment[].service_id". */
  param: string;
  /** Operation id that supplies it, e.g. "shipment.quote". */
  from: string;
  /** Response field path in that operation's `data`, e.g. "[].quotations[].courier.service_id". */
  field?: string;
  /** Short condition, e.g. "all-accounts login", "drop-off instead of pickup". */
  when?: string;
  /** One short sentence. */
  note?: string;
  /** false: never named in error hints (the value is the caller's own, e.g. an address).
   *  Edges without a `field` are never hinted either. */
  hint?: false;
}

/** Which target an operation acts on (the X-Account-Id / X-Organization-Id it reads). */
export type TargetScope = "account" | "organization";

export interface HumanTableContext {
  /** The profile's default account (marked in `ep account list`). */
  defaultAccountId?: string;
}

export interface PaginationSpec {
  /** Request body field that carries the paging cursor (e.g. before_shipment_number). */
  cursorField: string;
  /** Compute the cursor for the next (older) page from a response, or undefined to stop. */
  nextCursor: (env: Envelope) => string | undefined;
}

/**
 * A single API operation. This is the source of truth for BOTH the CLI command
 * and the MCP tool, so the two surfaces never drift apart.
 */
export interface Operation {
  /** Stable id, e.g. "shipment.quote". */
  id: string;
  group: OperationGroup;
  /** Subcommand name within the group, e.g. "quote" → `ep shipment quote`. */
  command: string;
  aliases?: string[];
  summary: string;
  description?: string;

  method: HttpMethod;
  /** Relative path; the version prefix /open_api/{version}/ is added automatically. */
  path: string;
  versioned?: boolean; // default true
  auth?: boolean; // default true

  /** Side-effecting: gains --dry-run, and MCP marks it non-readonly. */
  mutating?: boolean;
  /** Whether the operation accepts a JSON request body. */
  body: "json" | "none";
  bodyRequired?: boolean;

  /** JSON Schema for the request body (drives MCP inputSchema + `ep describe`). */
  schema?: JSONSchema;
  /** Example request body shown in help and `ep describe`. */
  example?: unknown;

  pagination?: PaginationSpec;
  /** Also expose as a top-level command (e.g. `ep quote`). */
  topLevelAlias?: string;
  /** Extra CLI usage examples. */
  examples?: string[];
  /** Known doc caveat surfaced in help (e.g. GET-with-body quirk). */
  docNote?: string;
  /** false = listing call that needs no target: the context's default account / organization
   *  is not sent (an explicit MCP account_id / organization_id still is). */
  target?: false;
  /** What a targeted call acts on (default "account"). Ignored when `target` is false. */
  scope?: TargetScope;
  /** Request fields that need a value fetched from another operation first. The account_id /
   *  organization_id edges are derived from `scope` (see `prerequisitesOf`), not listed here. */
  prerequisites?: Prerequisite[];
  /** Response fields (paths in `data`) other operations consume; checked against the edges. */
  provides?: string[];
  /** Human table for the CLI (used for --format table|csv, and by default on a terminal). */
  humanTable?: { columns: string[]; rows: (data: unknown, ctx?: HumanTableContext) => Record<string, unknown>[] };
}

// ---------------------------------------------------------------------------
// Small schema helpers (kept terse; the server is the source of truth for
// validation — these schemas exist to guide humans and agents).
// ---------------------------------------------------------------------------

export const str = (description?: string): JSONSchema => ({ type: "string", ...(description ? { description } : {}) });
export const num = (description?: string): JSONSchema => ({ type: "number", ...(description ? { description } : {}) });
export const bool = (description?: string): JSONSchema => ({ type: "boolean", ...(description ? { description } : {}) });
export const arr = (items: JSONSchema, description?: string): JSONSchema => ({
  type: "array",
  items,
  ...(description ? { description } : {}),
});
export const obj = (properties: Record<string, JSONSchema>, required?: string[]): JSONSchema => ({
  type: "object",
  properties,
  ...(required && required.length ? { required } : {}),
});

/** Render a boolean-ish cell for human tables ("" when unknown). */
export function yesNo(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return v === true || v === 1 || v === "1" || v === "true" ? "yes" : "no";
}

/** Sender/receiver address schema shared across shipment operations. */
export const addressSchema: JSONSchema = obj(
  {
    name: str("Contact name"),
    company: str(),
    phone_number_country_code: str('ISO alpha-2, e.g. "MY"'),
    phone_number: str(),
    alternate_phone_number_country_code: str(),
    alternate_phone_number: str(),
    email: str(),
    address_1: str(),
    address_2: str(),
    postcode: str(),
    city: str(),
    subdivision_code: str('ISO 3166-2, e.g. "MY-07"'),
    country_code: str("ISO 3166-1 alpha-2"),
    point_code: str(),
  },
  ["name", "phone_number_country_code", "phone_number", "address_1", "postcode", "city", "country_code"],
);
