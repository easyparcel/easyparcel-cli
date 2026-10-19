import { CliError, ExitCode } from "./errors";
import type { Envelope } from "./types";

// Per-request target for identity bearers (identity sign-in tokens and personal access tokens):
// the shipping account (`X-Account-Id`) and/or organization (`X-Organization-Id`) a call acts on.

export interface Target {
  accountId?: string;
  organizationId?: string;
}

export const ACCOUNT_HEADER = "X-Account-Id";
export const ORGANIZATION_HEADER = "X-Organization-Id";

function present(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** A shipping account id: digits only. Throws a usage error otherwise. */
export function validateAccountId(value: unknown, source = "account id"): string {
  const s = present(value);
  if (s === undefined || !/^\d+$/.test(s)) {
    throw new CliError(`Invalid ${source} '${String(value ?? "")}': an account id is numeric (see \`ep account list\`).`, ExitCode.USAGE);
  }
  return s;
}

/** An organization id (digits) or its 6-letter ref (uppercase). Throws a usage error otherwise. */
export function validateOrganizationId(value: unknown, source = "organization"): string {
  const s = present(value);
  if (s === undefined || !(/^\d+$/.test(s) || /^[A-Z]{6}$/.test(s))) {
    throw new CliError(
      `Invalid ${source} '${String(value ?? "")}': use the numeric organization id or its 6-letter ref, e.g. ABCDEF (see \`ep org list\`).`,
      ExitCode.USAGE,
    );
  }
  return s;
}

/**
 * Resolve the target for this invocation, each field on its own:
 * flag > env (EASYPARCEL_ACCOUNT_ID / EASYPARCEL_ORGANIZATION_ID) > profile default > none.
 */
export function resolveTarget(input: {
  flagAccount?: unknown;
  flagOrganization?: unknown;
  env?: Record<string, string | undefined>;
  profile?: { default_account_id?: number | string; default_organization_id?: string };
}): Target {
  const env = input.env ?? {};
  const pick = (
    pairs: Array<[unknown, string]>,
    validate: (v: unknown, source: string) => string,
  ): string | undefined => {
    for (const [v, source] of pairs) if (present(v) !== undefined) return validate(v, source);
    return undefined;
  };
  return {
    accountId: pick(
      [
        [input.flagAccount, "--account"],
        [env.EASYPARCEL_ACCOUNT_ID, "EASYPARCEL_ACCOUNT_ID"],
        [input.profile?.default_account_id, "profile default_account_id"],
      ],
      validateAccountId,
    ),
    organizationId: pick(
      [
        [input.flagOrganization, "--organization"],
        [env.EASYPARCEL_ORGANIZATION_ID, "EASYPARCEL_ORGANIZATION_ID"],
        [input.profile?.default_organization_id, "profile default_organization_id"],
      ],
      validateOrganizationId,
    ),
  };
}

/** Request headers for a target (empty when there is none). */
export function targetHeaders(target: Target): Record<string, string> {
  const h: Record<string, string> = {};
  if (target.accountId) h[ACCOUNT_HEADER] = target.accountId;
  if (target.organizationId) h[ORGANIZATION_HEADER] = target.organizationId;
  return h;
}

/** Error codes the API returns when a target is missing or refused (contract §2). */
const TARGET_ERRORS: Record<string, { cli: string; mcp?: string; usage?: boolean }> = {
  ACCOUNT_HEADER_REQUIRED: {
    cli: "This login covers all your accounts. Name one: `ep account list`, then `--account <id>` or `ep account use <id>`.",
    mcp: "This login covers all your accounts. Call ep_account_list, then pass account_id on this tool.",
    usage: true,
  },
  ACCOUNT_HEADER_INVALID: { cli: "The account id is not valid; use a numeric id from `ep account list`.", mcp: "account_id is not valid; use a numeric id from ep_account_list.", usage: true },
  ACCOUNT_OWNER_REQUIRED: { cli: "Only the account owner can use that account through the API; you are a team member on it." },
  ACCOUNT_FORBIDDEN: { cli: "This login cannot act on that account (not one you own, or it is closed). See `ep account list`.", mcp: "This login cannot act on that account (not one you own, or it is closed). See ep_account_list." },
  ORGANIZATION_HEADER_INVALID: { cli: "The organization id is not valid; use the numeric id or the 6-letter ref from `ep org list`.", mcp: "organization_id is not valid; use the numeric id or the 6-letter ref from ep_organization_list.", usage: true },
  ORGANIZATION_HEADER_REQUIRED: {
    cli: "This endpoint needs an organization: pass `--organization <id|ref>` or run `ep org use <id|ref>` (list them with `ep org list`).",
    mcp: "This tool needs an organization: call ep_organization_list, then pass organization_id.",
    usage: true,
  },
  ORGANIZATION_FORBIDDEN: { cli: "You are not a member of that organization. See `ep org list`.", mcp: "You are not a member of that organization. See ep_organization_list." },
  SWITCH_TOKEN_FORBIDDEN: {
    cli: "This login cannot mint per-account tokens; it already covers your accounts. Pass `--account <id>` instead.",
    mcp: "This login cannot mint per-account tokens; pass account_id instead.",
  },
};

/** The error code of a refused request, from the envelope (top level or inside `data`). */
export function envelopeCode(env: Envelope): string | undefined {
  const top = (env as Record<string, unknown>).code;
  if (typeof top === "string" && top) return top;
  const data = env.data as Record<string, unknown> | undefined;
  const inner = data && typeof data === "object" && !Array.isArray(data) ? data.code ?? data.error : undefined;
  return typeof inner === "string" && inner ? inner : undefined;
}

/**
 * A clear one-line message for a target-related refusal, keeping the server's message.
 * `usage` is true when the fix is on the caller's side (name a target), so the CLI exits 2.
 */
export function targetErrorHint(env: Envelope, surface: "cli" | "mcp" = "cli"): { message: string; usage: boolean } | undefined {
  const code = envelopeCode(env);
  const entry = code ? TARGET_ERRORS[code] : undefined;
  if (!entry) return undefined;
  const text = surface === "mcp" ? entry.mcp ?? entry.cli : entry.cli;
  const server = typeof env.message === "string" && env.message.trim() ? ` (${code}: ${env.message.trim()})` : ` (${code})`;
  return { message: text + server, usage: Boolean(entry.usage) };
}
