import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __setKeyringLoader, __resetKeyringLoader, type KeyringModule } from "../src/core/keychain";
import {
  setProfileCredentials,
  getProfileCredentials,
  clearProfile,
  listProfiles,
} from "../src/core/credentials";
import { credentialsPath } from "../src/core/paths";

/** An in-memory stand-in for @napi-rs/keyring (never touches the real OS store). */
function fakeKeyring(): { module: KeyringModule; store: Map<string, string> } {
  const store = new Map<string, string>();
  class Entry {
    private key: string;
    constructor(service: string, account: string) {
      this.key = `${service}:${account}`;
    }
    getPassword(): string | null {
      return store.has(this.key) ? store.get(this.key)! : null;
    }
    setPassword(v: string): void {
      store.set(this.key, v);
    }
    deletePassword(): boolean {
      return store.delete(this.key);
    }
  }
  return { module: { Entry: Entry as unknown as KeyringModule["Entry"] }, store };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-kc-"));
  process.env.EASYPARCEL_CONFIG_DIR = tmp;
  for (const k of [
    "EASYPARCEL_ACCESS_TOKEN",
    "EASYPARCEL_TOKEN",
    "EASYPARCEL_REFRESH_TOKEN",
    "EASYPARCEL_CLIENT_ID",
    "EASYPARCEL_CLIENT_SECRET",
  ]) {
    delete process.env[k];
  }
});

afterEach(() => {
  __resetKeyringLoader();
  delete process.env.EASYPARCEL_CONFIG_DIR;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("keychain-backed credential store", () => {
  it("writes secrets to the keychain and keeps them OUT of the 0600 file", () => {
    const { module, store } = fakeKeyring();
    __setKeyringLoader(() => module);

    setProfileCredentials("default", {
      access_token: "AT",
      refresh_token: "RT",
      expires_at: "2030-01-01T00:00:00Z",
      client_id: "cid",
    });

    const fileRaw = fs.readFileSync(credentialsPath(), "utf8");
    expect(fileRaw).not.toContain("AT"); // secret value never hits disk
    expect(fileRaw).not.toContain("RT");
    expect(fileRaw).toContain("keychain"); // storage marker present
    expect(fileRaw).toContain("cid"); // non-secret metadata stays in the index

    // Non-default config dirs get a namespaced entry (profile:default@<dir hash>).
    const key = [...store.keys()].find((k) => k.startsWith("easyparcel-cli:profile:default"));
    expect(key).toBeTruthy();
    const blob = store.get(key!);
    expect(blob).toBeTruthy();
    expect(JSON.parse(blob!)).toMatchObject({ access_token: "AT", refresh_token: "RT" });

    const creds = getProfileCredentials("default");
    expect(creds.access_token).toBe("AT");
    expect(creds.refresh_token).toBe("RT");
    expect(creds.expires_at).toBe("2030-01-01T00:00:00Z");
    expect((creds as Record<string, unknown>).storage).toBeUndefined(); // marker stripped on read
    expect(listProfiles()).toEqual(["default"]);
  });

  it("falls back to the plaintext file when no keychain is available", () => {
    __setKeyringLoader(() => null);

    setProfileCredentials("default", { access_token: "AT", refresh_token: "RT" });

    const fileRaw = fs.readFileSync(credentialsPath(), "utf8");
    expect(fileRaw).toContain("AT");
    expect(fileRaw).toContain("RT");
    expect(getProfileCredentials("default").access_token).toBe("AT");
  });

  it("clearProfile removes both the keychain entry and the file record", () => {
    const { module, store } = fakeKeyring();
    __setKeyringLoader(() => module);

    setProfileCredentials("default", { access_token: "AT", refresh_token: "RT" });
    expect(store.size).toBe(1);

    expect(clearProfile("default")).toBe(true);
    expect(store.size).toBe(0);
    expect(getProfileCredentials("default").access_token).toBeUndefined();
    expect(listProfiles()).toEqual([]);
  });

  it("merges partial updates while preserving keychain-held secrets", () => {
    const { module } = fakeKeyring();
    __setKeyringLoader(() => module);

    setProfileCredentials("default", { access_token: "AT1", refresh_token: "RT1" });
    setProfileCredentials("default", { access_token: "AT2" }); // a refresh that does not rotate RT

    const creds = getProfileCredentials("default");
    expect(creds.access_token).toBe("AT2");
    expect(creds.refresh_token).toBe("RT1");
  });
});

describe("keychain entries are namespaced by config directory", () => {
  it("two config dirs with the same profile name never share a keychain entry", () => {
    const fk = fakeKeyring();
    __setKeyringLoader(() => fk.module);
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ep-kc-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ep-kc-b-"));
    try {
      process.env.EASYPARCEL_CONFIG_DIR = dirA;
      setProfileCredentials("default", { access_token: "A-token", refresh_token: "A-refresh", token_type: "Bearer" });
      process.env.EASYPARCEL_CONFIG_DIR = dirB;
      setProfileCredentials("default", { access_token: "B-token", refresh_token: "B-refresh", token_type: "Bearer" });
      expect(fk.store.size).toBe(2);
      expect(getProfileCredentials("default").access_token).toBe("B-token");
      clearProfile("default");
      process.env.EASYPARCEL_CONFIG_DIR = dirA;
      expect(getProfileCredentials("default").access_token).toBe("A-token");
      expect([...fk.store.keys()].every((k) => k.startsWith("easyparcel-cli:profile:default@"))).toBe(true);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
  it("the default ~/.easyparcel directory keeps the legacy bare entry name", () => {
    const fk = fakeKeyring();
    __setKeyringLoader(() => fk.module);
    const home = path.join(os.homedir(), ".easyparcel");
    const existed = fs.existsSync(home);
    const backup = existed ? fs.readFileSync(path.join(home, "credentials.json"), "utf8").toString() : null;
    process.env.EASYPARCEL_CONFIG_DIR = home;
    try {
      setProfileCredentials("kc-naming-probe", { access_token: "x", token_type: "Bearer" });
      expect(fk.store.has("easyparcel-cli:profile:kc-naming-probe")).toBe(true);
    } finally {
      clearProfile("kc-naming-probe");
      if (backup !== null) fs.writeFileSync(path.join(home, "credentials.json"), backup);
    }
  });
});
