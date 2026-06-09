import fs from "node:fs";
import { credentialsPath } from "./paths";
import { ensureConfigDir } from "./config";
import type { CredentialStore, ProfileCredentials } from "./types";

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
  if (process.env.EASYPARCEL_ACCESS_TOKEN) env.access_token = process.env.EASYPARCEL_ACCESS_TOKEN;
  if (process.env.EASYPARCEL_REFRESH_TOKEN) env.refresh_token = process.env.EASYPARCEL_REFRESH_TOKEN;
  if (process.env.EASYPARCEL_CLIENT_ID) env.client_id = process.env.EASYPARCEL_CLIENT_ID;
  if (process.env.EASYPARCEL_CLIENT_SECRET) env.client_secret = process.env.EASYPARCEL_CLIENT_SECRET;
  return env;
}

/** True if any credential is supplied via the environment. */
export function hasEnvCredentials(): boolean {
  return Boolean(process.env.EASYPARCEL_ACCESS_TOKEN || process.env.EASYPARCEL_REFRESH_TOKEN);
}

/** Resolved credentials for a profile: stored values with env overrides merged on top. */
export function getProfileCredentials(profile: string): ProfileCredentials {
  const store = loadStore();
  const stored = store.profiles[profile] ?? {};
  return { ...stored, ...envCredentials() };
}

export function setProfileCredentials(profile: string, creds: ProfileCredentials): void {
  const store = loadStore();
  store.profiles[profile] = { ...store.profiles[profile], ...creds };
  saveStore(store);
}

export function clearProfile(profile: string): boolean {
  const store = loadStore();
  if (!store.profiles[profile]) return false;
  delete store.profiles[profile];
  saveStore(store);
  return true;
}

export function listProfiles(): string[] {
  return Object.keys(loadStore().profiles);
}
