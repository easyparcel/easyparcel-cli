// Shared type definitions for the EasyParcel CLI core.

export type Format = "json" | "pretty" | "table" | "ndjson" | "csv";

/** Persisted, non-secret CLI configuration (~/.easyparcel/config.json). */
export interface EpConfig {
  base_url: string;
  api_version: string;
  default_profile: string;
  /** Optional override for the built-in OAuth client id (else DEFAULT_CLIENT_ID). */
  client_id?: string;
  /** Optional saved defaults used by Layer-1 shortcuts (e.g. a default sender). */
  defaults?: Record<string, unknown>;
}

/** Per-profile secrets stored in ~/.easyparcel/credentials.json (chmod 0600). */
export interface ProfileCredentials {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  /** ISO timestamp when the access token expires. */
  expires_at?: string;
  refresh_token_expires_at?: string;
  /** ISO timestamp when these tokens were obtained. */
  obtained_at?: string;
  client_id?: string;
  client_secret?: string;
  scope?: string;
  /** Human label for the connected account (best-effort). */
  account_label?: string;
}

export interface CredentialStore {
  version: number;
  profiles: Record<string, ProfileCredentials>;
}

/** OAuth token endpoint response (see /oauth/token). */
export interface TokenResponse {
  token_type: string;
  expires_in?: number;
  expires_at?: string;
  access_token: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  refresh_token_expires_at?: string;
  scope?: string;
  app?: unknown;
}

/** Standard EasyParcel response envelope. */
export interface Envelope<T = unknown> {
  status_code: number;
  request_id?: string;
  message?: string;
  data: T;
  error?: unknown;
  /** HTTP status attached by the client (may differ from status_code). */
  _http_status?: number;
  [k: string]: unknown;
}
