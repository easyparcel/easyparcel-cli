import { getProfileCredentials, setProfileCredentials } from "./credentials";
import { refreshToken } from "./oauth";
import { CliError, ExitCode } from "./errors";
import { log } from "./logger";
import type { RuntimeContext } from "./context";
import type { ProfileCredentials, TokenResponse } from "./types";

const SKEW_MS = 30_000;

/** True when the access token is known to be expired (or about to). */
export function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false; // unknown expiry → assume valid; a 401 will trigger refresh
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() + SKEW_MS >= t;
}

export function tokensFromResponse(tr: TokenResponse, extra?: Partial<ProfileCredentials>): ProfileCredentials {
  const now = Date.now();
  const expires_at =
    tr.expires_at ?? (tr.expires_in ? new Date(now + tr.expires_in * 1000).toISOString() : undefined);
  return {
    access_token: tr.access_token,
    refresh_token: tr.refresh_token,
    token_type: tr.token_type,
    expires_at,
    refresh_token_expires_at: tr.refresh_token_expires_at,
    obtained_at: new Date(now).toISOString(),
    scope: tr.scope,
    ...extra,
  };
}

/**
 * Persist tokens to disk, UNLESS the user is in pure env-injection mode
 * (EASYPARCEL_ACCESS_TOKEN set) — in that case the agent/CI owns the tokens
 * and we never write to disk.
 */
export function maybePersist(ctx: RuntimeContext, creds: ProfileCredentials): void {
  if (process.env.EASYPARCEL_ACCESS_TOKEN) return;
  setProfileCredentials(ctx.profile, creds);
}

export async function getValidAccessToken(ctx: RuntimeContext): Promise<string> {
  const creds = getProfileCredentials(ctx.profile);
  if (!creds.access_token && !creds.refresh_token) {
    throw new CliError("Not authenticated. Run `ep auth login`, or set EASYPARCEL_ACCESS_TOKEN.", ExitCode.AUTH);
  }
  if (creds.access_token && !isExpired(creds.expires_at)) return creds.access_token;
  if (creds.refresh_token) {
    const tok = await doRefresh(ctx, creds);
    if (tok) return tok;
  }
  if (creds.access_token) return creds.access_token; // last resort; may be valid
  throw new CliError("No usable access token. Run `ep auth login`.", ExitCode.AUTH);
}

/** Attempt a refresh; returns the new access token or undefined on failure. */
export async function doRefresh(ctx: RuntimeContext, creds?: ProfileCredentials): Promise<string | undefined> {
  const c = creds ?? getProfileCredentials(ctx.profile);
  if (!c.refresh_token) return undefined;
  log.debug("refreshing access token");
  try {
    const tr = await refreshToken({
      baseUrl: ctx.baseUrl,
      clientId: c.client_id ?? process.env.EASYPARCEL_CLIENT_ID,
      clientSecret: c.client_secret ?? process.env.EASYPARCEL_CLIENT_SECRET,
      refreshToken: c.refresh_token,
    });
    const next = tokensFromResponse(tr, {
      client_id: c.client_id,
      client_secret: c.client_secret,
      account_label: c.account_label,
    });
    if (!next.refresh_token) next.refresh_token = c.refresh_token; // keep if not rotated
    maybePersist(ctx, next);
    return next.access_token;
  } catch (e) {
    log.debug(`token refresh failed: ${(e as Error).message}`);
    return undefined;
  }
}
