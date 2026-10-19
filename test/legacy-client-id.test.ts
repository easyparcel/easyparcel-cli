import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClient } from "../src/cli/auth";
import { DEFAULT_CLIENT_ID, MCP_BROKER_CLIENT_ID } from "../src/core/config";
import { oauthErrorDetail } from "../src/core/oauth";

const ctx = { profile: "default", config: {} } as any;
let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-legacy-"));
  process.env.EASYPARCEL_CONFIG_DIR = dir;
  delete process.env.EASYPARCEL_CLIENT_ID;
  delete process.env.EASYPARCEL_CLIENT_SECRET;
  delete process.env.EASYPARCEL_ACCESS_TOKEN;
  delete process.env.EASYPARCEL_TOKEN;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

const storeProfile = (client_id: string) =>
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ version: 1, profiles: { default: { client_id, access_token: "old", refresh_token: "old", expires_at: "2026-06-03T13:20:24.905Z" } } }),
  );

describe("resolveClient: a client id stored by an older CLI never drives a new login", () => {
  it("falls back to the EasyParcel CLI app when the stored id is the legacy broker app", () => {
    storeProfile(MCP_BROKER_CLIENT_ID);
    expect(resolveClient(ctx, {}).clientId).toBe(DEFAULT_CLIENT_ID);
  });
  it("still honours an explicit flag or env naming that app", () => {
    storeProfile(MCP_BROKER_CLIENT_ID);
    expect(resolveClient(ctx, { clientId: MCP_BROKER_CLIENT_ID }).clientId).toBe(MCP_BROKER_CLIENT_ID);
    process.env.EASYPARCEL_CLIENT_ID = MCP_BROKER_CLIENT_ID;
    expect(resolveClient(ctx, {}).clientId).toBe(MCP_BROKER_CLIENT_ID);
  });
  it("keeps using a stored custom client id", () => {
    storeProfile("11111111-2222-4333-8444-555555555555");
    expect(resolveClient(ctx, {}).clientId).toBe("11111111-2222-4333-8444-555555555555");
  });
});

describe("oauthErrorDetail: the server's reason is shown, whichever envelope carried it", () => {
  it("unwraps the Developer Hub wrapper around core's body", () => {
    const hub = { error: "device_authorization_failed", status_code: 400, data: { status_code: 400, message: "Unknown or non-public client_id", data: { error: "invalid_client", error_description: "Unknown or non-public client_id" } } };
    expect(oauthErrorDetail(hub, "x")).toBe("Unknown or non-public client_id (invalid_client)");
  });
  it("reads a bare RFC 6749 body and falls back when nothing is there", () => {
    expect(oauthErrorDetail({ error: "slow_down" }, "x")).toBe("slow_down");
    expect(oauthErrorDetail({ error: "invalid_grant", error_description: "code expired" }, "x")).toBe("code expired (invalid_grant)");
    expect(oauthErrorDetail(undefined, "device authorization failed (HTTP 502)")).toBe("device authorization failed (HTTP 502)");
  });
});
