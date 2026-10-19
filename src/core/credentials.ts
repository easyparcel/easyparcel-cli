import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { credentialsPath, configDir } from "./paths";
import { ensureConfigDir } from "./config";
import { keychainAvailable, keychainGet, keychainSet, keychainDelete } from "./keychain";
import { log } from "./logger";
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

// Profiles already warned about in this process: a credential read happens several times per
// command, and one warning is enough.
const warnedUnreadable = new Set<string>();

function keychainAccount(profile: string): string {
  // Entries are namespaced by the config directory: two configs (a scratch
  // EASYPARCEL_CONFIG_DIR next to the real ~/.easyparcel, or two environments) must never
  // read or overwrite each other's secrets under the same profile name. The default
  // directory keeps the legacy bare name so existing installs find their tokens.
  const dir = path.resolve(configDir());
  const defaultDir = path.resolve(path.join(os.homedir(), ".easyparcel"));
  if (dir === defaultDir) return `profile:${profile}`;
  const tag = crypto.createHash("sha256").update(dir).digest("hex").slice(0, 12);
  return `profile:${profile}@${tag}`;
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
    // Keychain entry missing or unreadable (creds file copied to another machine, or this
    // process was denied the item) → metadata only. Say so, or it just looks like "not logged in";
    // once per process, and not when an env token makes the stored profile irrelevant.
    if (!warnedUnreadable.has(profile) && !hasEnvAccessToken()) {
      warnedUnreadable.add(profile);
      log.warn(`Profile '${profile}' keeps its tokens in the OS keychain, but the entry could not be read. Run \`ep login\` again.`);
    }
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
    if (hasSecret && keychainAvailable()) {
      log.warn("Could not write to the OS keychain; the tokens were saved to the credentials file (mode 0600) instead.");
    }
    store.profiles[profile] = { ...merged, storage: "file" };
    // Drop any stale keychain entry so the file stays the single source of truth.
    if (keychainAvailable()) keychainDelete(keychainAccount(profile));
  }
  saveStore(store);
}

/**
 * Set or remove NON-secret profile fields (e.g. default_account_id) in the file index only, so the
 * keychain is never touched. `undefined` removes a field. Creates the profile entry if needed.
 */
export function updateProfileMetadata(
  profile: string,
  patch: Partial<Pick<ProfileCredentials, "default_account_id" | "default_organization_id">>,
): void {
  const store = loadStore();
  const rec: Record<string, unknown> = { ...(store.profiles[profile] ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete rec[k];
    else rec[k] = v;
  }
  store.profiles[profile] = rec as ProfileCredentials;
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
