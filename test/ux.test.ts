import { describe, it, expect } from "vitest";
import { signedInAs, statusLine } from "../src/cli/auth";
import { walletRows } from "../src/operations/account";
import { getOperation } from "../src/operations";
import { renderTable, makeColor } from "../src/core/output";
import { SIGNED_OUT_MESSAGE } from "../src/core/tokens";

const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const NOW = Date.parse("2026-10-19T10:00:00Z");

describe("ep auth status human line", () => {
  it("identity login: who, all accounts, profile, minutes left, storage", () => {
    const creds = {
      access_token: jwt({ token_kind: "identity", user: { id: "187587" }, exp: NOW / 1000 + 42 * 60 }),
      refresh_token: "r",
      identity: true,
    };
    expect(statusLine("default", creds, { storage: "keychain", source: "store", nowMs: NOW })).toBe(
      "Signed in as user 187587 — all accounts; profile default; token expires in 42 min; storage keychain",
    );
  });

  it("account-bound login prefers a name or email claim and shows the account and defaults", () => {
    const creds = {
      access_token: jwt({ user: { id: "1", account_id: 123456, email: "ops@example.test" } }),
      expires_at: new Date(NOW - 60_000).toISOString(),
      refresh_token: "r",
      default_organization_id: "ABCDEF",
    };
    expect(statusLine("shop", creds, { storage: "file", source: "store", nowMs: NOW })).toBe(
      "Signed in as ops@example.test — account 123456; profile shop; token expired (renews on the next call); storage file; default organization ABCDEF",
    );
  });

  it("signed out names both login flows", () => {
    expect(statusLine("default", {}, { storage: "keychain", source: "none" })).toContain("`ep login`");
    expect(SIGNED_OUT_MESSAGE).toContain("`ep login --device`");
    expect(signedInAs({ access_token: "epat_x" })).toBe("a personal access token");
    // an opaque (encrypted) user id is never shown
    const opaque = { access_token: jwt({ token_kind: "identity", user: { id: "f8c5NU/kT==" } }), identity: true };
    expect(signedInAs(opaque)).toBeUndefined();
    expect(statusLine("default", opaque, { storage: "keychain", source: "store" })).toMatch(/^Signed in — all accounts; profile default; /);
  });
});

describe("ep wallet --format table", () => {
  it("renders one row per balance", () => {
    const data = { wallet: [{ balance: 152.18, currency: "MYR" }], free_credit_wallet: [{ balance: 3, currency: "MYR" }] };
    const op = getOperation("account.wallet")!;
    const out = renderTable(walletRows(data), op.humanTable!.columns, makeColor(false)).split("\n");
    expect(out[0].split("|").map((s) => s.trim())).toEqual(["WALLET", "BALANCE", "CURRENCY"]);
    expect(out[2]).toMatch(/credit\s+\|\s+152.18\s+\|\s+MYR/);
    expect(out[3]).toMatch(/free credit\s+\|\s+3\s+\|\s+MYR/);
  });
});
