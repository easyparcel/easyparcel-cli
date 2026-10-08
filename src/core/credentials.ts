import fs from "node:fs";
import { credentialsPath } from "./paths";
import { ensureConfigDir } from "./config";
import { keychainAvailable, keychainGet, keychainSet, keychainDelete } from "./keychain";
import type { CredentialStore, ProfileCredentials } from "./types";

// Credential storage with two backends:
//   • OS keychain (preferred) — holds the SECRET fields per profile as one JSON
//     blob (service "easyparcel-cli", account "profile:<name>").
//   • ~/.easyparcel/credentials.json (mode 0600) — always holds the profile INDEX
//     and non-secret metadata; also holds the secrets themselves when no keychain
//     is available (legacy behaviour, fully preserved).
// The file therefore always lists every profile (so `auth status` / listProfiles
// work without touching the keychain), while the tokens stay in the keychain when
// one exists. Tokens supplied via environment variables are overlaid at read time
// and never written to either backend.

/** Secret fields kept out of the plaintext file when a keychain is present. */
const SECRET_KEYS = ["access_token", "refresh_token", "client_secret"] as const;

function keychainAccount(profile: string): string {
  return `profile:${profile}`;
}

function emptyStore(): CredentialStore {
  return { version: 1, profiles: {} };
}

export function loadStore(): CredentialStore {
  try {
    const raw = fs.readFileSync(credentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CredentialStore>;
    return { version: 1, profiles: {}, ...parsed } as CredentialStore;
  } catch {
    return emptyStore();
  }
}

export function saveStore(store: CredentialStore): void {
  ensureConfigDir();
  fs.writeFileSync(credentialsPath(), JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

/** Tokens supplied via environment (highest precedence; never persisted). */
export function envCredentials(): ProfileCredentials {
  const env: ProfileCredentials = {};
  // EASYPARCEL_TOKEN is accepted alongside EASYPARCEL_ACCESS_TOKEN (CI / headless).
  const access = process.env.EASYPARCEL_ACCESS_TOKEN || process.env.EASYPARCEL_TOKEN;
  if (access) env.access_token = access;
  if (process.env.EASYPARCEL_REFRESH_TOKEN) env.refresh_token = process.env.EASYPARCEL_REFRESH_TOKEN;
  if (process.env.EASYPARCEL_CLIENT_ID) env.client_id = process.env.EASYPARCEL_CLIENT_ID;
  if (process.env.EASYPARCEL_CLIENT_SECRET) env.client_secret = process.env.EASYPARCEL_CLIENT_SECRET;
  return env;
}

/** True if any credential is supplied via the environment. */
export function hasEnvCredentials(): boolean {
  return Boolean(
    process.env.EASYPARCEL_ACCESS_TOKEN ||
      process.env.EASYPARCEL_TOKEN ||
      process.env.EASYPARCEL_REFRESH_TOKEN,
  );
}

/**
 * True when a static access token is injected via env. In this mode the agent/CI
 * owns the tokens and the CLI must never write them to disk or the keychain.
 */
export function hasEnvAccessToken(): boolean {
  return Boolean(process.env.EASYPARCEL_ACCESS_TOKEN || process.env.EASYPARCEL_TOKEN);
}

function splitSecrets(creds: ProfileCredentials): {
  secret: Partial<ProfileCredentials>;
  nonSecret: ProfileCredentials;
} {
  const secret: Record<string, unknown> = {};
  const nonSecret: Record<string, unknown> = { ...creds };
  for (const k of SECRET_KEYS) {
    if (creds[k] !== undefined) {
      secret[k] = creds[k];
      delete nonSecret[k];
    }
  }
  return { secret: secret as Partial<ProfileCredentials>, nonSecret: nonSecret as ProfileCredentials };
}

/** Full stored credentials for a profile (keychain + file), WITHOUT env overlay. */
function readStoredProfile(profile: string): ProfileCredentials {
  const store = loadStore();
  const rec = store.profiles[profile];
  if (!rec) return {};
  const { storage, ...rest } = rec;
  if (storage === "keychain") {
    const raw = keychainGet(keychainAccount(profile));
    if (raw) {
      try {
        return { ...(rest as ProfileCredentials), ...(JSON.parse(raw) as ProfileCredentials) };
      } catch {
        return rest as ProfileCredentials;
      }
    }
    // Keychain entry missing (e.g. creds file copied to another machine) → metadata only.
    return rest as ProfileCredentials;
  }
  return rest as ProfileCredentials;
}

/** Resolved credentials for a profile: stored values with env overrides merged on top. */
export function getProfileCredentials(profile: string): ProfileCredentials {
  return { ...readStoredProfile(profile), ...envCredentials() };
}

export function setProfileCredentials(profile: string, creds: ProfileCredentials): void {
  // Merge onto existing stored creds so partial updates (e.g. a refresh) keep the rest.
  const merged = { ...readStoredProfile(profile), ...creds };
  delete (merged as ProfileCredentials).storage;
  const { secret, nonSecret } = splitSecrets(merged);
  const store = loadStore();
  const hasSecret = Object.keys(secret).length > 0;

  if (hasSecret && keychainAvailable() && keychainSet(keychainAccount(profile), JSON.stringify(secret))) {
    store.profiles[profile] = { ...nonSecret, storage: "keychain" };
  } else {
    // No keychain (or write failed) → persist everything to the 0600 file.
    store.profiles[profile] = { ...merged, storage: "file" };
    // Drop any stale keychain entry so the file stays the single source of truth.
    if (keychainAvailable()) keychainDelete(keychainAccount(profile));
  }
  saveStore(store);
}

export function clearProfile(profile: string): boolean {
  const store = loadStore();
  const existed = Boolean(store.profiles[profile]);
  // Best-effort keychain removal regardless of the recorded backend.
  if (keychainAvailable()) keychainDelete(keychainAccount(profile));
  if (!existed) return false;
  delete store.profiles[profile];
  saveStore(store);
  return true;
}

export function listProfiles(): string[] {
  return Object.keys(loadStore().profiles);
}
