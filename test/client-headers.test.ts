import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/core/http", () => ({
  rawRequest: vi.fn(),
  sleep: vi.fn(async () => undefined),
}));
vi.mock("../src/core/tokens", () => ({
  getValidAccessToken: vi.fn(async () => "stored-token"),
  doRefresh: vi.fn(async () => "refreshed-token"),
}));

import { rawRequest } from "../src/core/http";
import { doRefresh } from "../src/core/tokens";
import { apiRequest } from "../src/core/client";
import type { RuntimeContext } from "../src/core/context";

const raw = vi.mocked(rawRequest);

function ctx(target: { accountId?: string; organizationId?: string } = {}): RuntimeContext {
  return {
    config: { base_url: "https://api.example.test", api_version: "2026-03", default_profile: "default" },
    baseUrl: "https://api.example.test",
    apiVersion: "2026-03",
    profile: "default",
    format: "json",
    formatExplicit: false,
    dryRun: false,
    color: false,
    quiet: true,
    verbose: false,
    dataOnly: false,
    failOnItemError: false,
    timeoutMs: 1000,
    retries: 0,
    page: { all: false, delayMs: 0 },
    ...target,
  };
}

const ok = { status: 200, headers: {}, body: JSON.stringify({ status_code: 200, data: {} }) };
const unauthorized = { status: 401, headers: {}, body: JSON.stringify({ status_code: 401, message: "Invalid Access Token" }) };
const sentHeaders = (call: number) => (raw.mock.calls[call][1] as { headers: Record<string, string> }).headers;

beforeEach(() => {
  raw.mockReset();
  vi.mocked(doRefresh).mockClear();
});

describe("apiRequest target headers", () => {
  it("sends X-Account-Id / X-Organization-Id on the first call and on the retry after a 401 refresh", async () => {
    raw.mockResolvedValueOnce(unauthorized).mockResolvedValueOnce(ok);
    await apiRequest(ctx({ accountId: "123", organizationId: "ABCDEF" }), { method: "GET", path: "wallet" });
    expect(raw).toHaveBeenCalledTimes(2);
    expect(doRefresh).toHaveBeenCalledOnce();
    for (const i of [0, 1]) {
      expect(sentHeaders(i)["X-Account-Id"]).toBe("123");
      expect(sentHeaders(i)["X-Organization-Id"]).toBe("ABCDEF");
    }
    expect(sentHeaders(0).Authorization).toBe("Bearer stored-token");
    expect(sentHeaders(1).Authorization).toBe("Bearer refreshed-token");
  });

  it("sends no target headers when there is no target", async () => {
    raw.mockResolvedValueOnce(ok);
    await apiRequest(ctx(), { method: "GET", path: "account/list_accounts" });
    const h = sentHeaders(0);
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("x-account-id");
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("x-organization-id");
  });

  it("skips the context target for target-free calls and for a per-request bearer", async () => {
    raw.mockResolvedValue(ok);
    await apiRequest(ctx({ accountId: "123" }), { method: "GET", path: "account/list_accounts", target: false });
    await apiRequest(ctx({ accountId: "123" }), { method: "GET", path: "wallet", accessToken: "client-token" });
    expect(sentHeaders(0)["X-Account-Id"]).toBeUndefined();
    expect(sentHeaders(1)["X-Account-Id"]).toBeUndefined();
  });

  it("lets explicit headers replace the context target, case-insensitively", async () => {
    raw.mockResolvedValue(ok);
    await apiRequest(ctx({ accountId: "123" }), { method: "GET", path: "wallet", headers: { "x-account-id": "456" } });
    const h = sentHeaders(0);
    expect(h["x-account-id"]).toBe("456");
    expect(h["X-Account-Id"]).toBeUndefined();
  });
});
