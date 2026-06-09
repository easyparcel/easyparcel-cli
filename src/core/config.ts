import fs from "node:fs";
import { configDir, configPath } from "./paths";
import type { EpConfig } from "./types";

export const DEFAULT_BASE_URL = "https://api.easyparcel.com";
export const DEFAULT_API_VERSION = "2026-03";
export const DEFAULT_PROFILE = "default";
/** Fixed loopback port for the OAuth callback (register http://localhost:8788/callback). */
export const DEFAULT_CALLBACK_PORT = 8788;

/**
 * Built-in first-party OAuth client for the EasyParcel CLI.
 *
 * This is a PUBLIC client: the authorization_code + PKCE flow needs no secret,
 * so it is safe to ship. With this set, end users just run `ep auth login` —
 * no app creation, no client id/secret to manage.
 *
 * The current EasyParcel backend treats Developer-Hub apps as CONFIDENTIAL
 * clients (the token endpoint requires the secret), so we also ship a built-in
 * secret. Combined with PKCE this matches the standard posture for distributed
 * CLIs (gcloud/aws/etc.): the embedded secret only identifies the app and
 * cannot be used without a user completing the PKCE-protected consent flow.
 * The built-in secret is only used when the client id is the built-in one.
 *
 * TODO(easyparcel): replace BOTH with the official "EasyParcel CLI" app's
 * credentials (registered with redirect URI http://localhost:8788/callback).
 * If/when the backend supports public (PKCE-only) clients, set
 * DEFAULT_CLIENT_SECRET back to "". Override at runtime via --client-id /
 * --client-secret / EASYPARCEL_CLIENT_ID / `ep config set client_id <id>`.
 */
export const DEFAULT_CLIENT_ID = "675a19ed-bb9b-4e88-b3e6-9b1b46ce745c";
// Intentionally empty: do NOT commit a real client secret here (it would ship in
// the published package). Provide it at runtime instead — EASYPARCEL_CLIENT_SECRET,
// --client-secret, or `ep auth login` against a public/PKCE client. See README.
export const DEFAULT_CLIENT_SECRET = "";

export function defaultConfig(): EpConfig {
  return {
    base_url: DEFAULT_BASE_URL,
    api_version: DEFAULT_API_VERSION,
    default_profile: DEFAULT_PROFILE,
  };
}

export function loadConfig(): EpConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<EpConfig>;
    return { ...defaultConfig(), ...parsed };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(cfg: EpConfig): void {
  ensureConfigDir();
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export function ensureConfigDir(): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
}
