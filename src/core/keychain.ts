import { createRequire } from "node:module";
import { log } from "./logger";

// OS keychain backend for credential storage.
//
// Wraps @napi-rs/keyring (prebuilt N-API bindings over the Rust `keyring` crate:
// macOS Keychain, Windows Credential Manager, Linux libsecret/secret-service).
// It is an OPTIONAL dependency: the native module may be absent (unsupported
// platform, --no-optional install, headless CI). Every path here must degrade to
// `null`/`false` so the caller falls back to the 0600 credentials file rather than
// crashing. The module is loaded lazily via createRequire so the ESM bundle never
// hard-links it and a missing binary is a caught require() error, not a load crash.

const SERVICE = "easyparcel-cli";

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

type Loader = () => KeyringModule | null;

function defaultLoader(): KeyringModule | null {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("@napi-rs/keyring") as KeyringModule;
    if (!mod || typeof mod.Entry !== "function") return null;
    return mod;
  } catch (e) {
    log.debug(`OS keychain unavailable (module load): ${(e as Error).message}`);
    return null;
  }
}

let loader: Loader = defaultLoader;
// undefined = not yet attempted; null = attempted, no keychain.
let cached: KeyringModule | null | undefined;

/**
 * Test seam: swap the keyring module (pass a fake to simulate a present native
 * module, or null to simulate its absence). Resets the availability cache.
 */
export function __setKeyringLoader(fn: Loader): void {
  loader = fn;
  cached = undefined;
}

/** Restore the real loader (tests call this in afterEach). */
export function __resetKeyringLoader(): void {
  loader = defaultLoader;
  cached = undefined;
}

function keyring(): KeyringModule | null {
  if (cached === undefined) cached = loader();
  return cached;
}

/** True when an OS keychain is usable on this machine. */
export function keychainAvailable(): boolean {
  return keyring() !== null;
}

function entry(account: string): KeyringEntry | null {
  const mod = keyring();
  if (!mod) return null;
  try {
    return new mod.Entry(SERVICE, account);
  } catch (e) {
    log.debug(`keychain entry init failed for ${account}: ${(e as Error).message}`);
    return null;
  }
}

/** Read a stored secret, or null if absent / keychain unavailable / locked. */
export function keychainGet(account: string): string | null {
  const e = entry(account);
  if (!e) return null;
  try {
    return e.getPassword();
  } catch (err) {
    log.debug(`keychain read failed for ${account}: ${(err as Error).message}`);
    return null;
  }
}

/** Store a secret. Returns false (so the caller falls back to the file) on any failure. */
export function keychainSet(account: string, value: string): boolean {
  const e = entry(account);
  if (!e) return false;
  try {
    e.setPassword(value);
    return true;
  } catch (err) {
    log.debug(`keychain write failed for ${account}: ${(err as Error).message}`);
    return false;
  }
}

/** Best-effort delete. Returns true when a credential was removed. */
export function keychainDelete(account: string): boolean {
  const e = entry(account);
  if (!e) return false;
  try {
    return e.deletePassword();
  } catch (err) {
    log.debug(`keychain delete failed for ${account}: ${(err as Error).message}`);
    return false;
  }
}
