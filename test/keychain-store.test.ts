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

    const blob = store.get("easyparcel-cli:profile:default");
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
