// Unverified JWT payload reads. Never used for trust decisions on the client side: the server
// verifies every token. These only shape UX (identity vs account-bound login, expiry hints).

/** Decode a JWT's payload without verifying it; undefined when the value is not a JWT. */
export function decodeJwtPayload(token?: string): Record<string, any> | undefined {
  try {
    const parts = String(token ?? "").split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a sign-in token covers the person's accounts rather than one account: the payload
 * says `token_kind: "identity"`, or it is a JWT without `user.account_id`. Opaque (non-JWT)
 * tokens are never classed as identity here.
 */
export function isIdentityToken(token?: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  if (payload.token_kind === "identity") return true;
  const id = payload.user?.account_id;
  return id === undefined || id === null || id === "";
}

/** True when the value is a JWT whose `exp` claim (seconds) has passed. */
export function isJwtExpired(token?: string, nowMs: number = Date.now()): boolean {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp * 1000 <= nowMs;
}
