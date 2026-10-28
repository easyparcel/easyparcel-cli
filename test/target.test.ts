import { describe, it, expect } from "vitest";
import { resolveTarget, targetHeaders, targetErrorHint, validateOrganizationId } from "../src/core/target";
import { isIdentityToken, isJwtExpired } from "../src/core/jwt";
import { CliError, ExitCode } from "../src/core/errors";

const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("resolveTarget precedence", () => {
  const profile = { default_account_id: 111, default_organization_id: "PROFIL" };
  const env = { EASYPARCEL_ACCOUNT_ID: "222", EASYPARCEL_ORGANIZATION_ID: "333" };

  it("flag beats env beats profile default", () => {
    expect(resolveTarget({ flagAccount: "999", flagOrganization: "ABCDEF", env, profile })).toEqual({
      accountId: "999",
      organizationId: "ABCDEF",
    });
    expect(resolveTarget({ env, profile })).toEqual({ accountId: "222", organizationId: "333" });
    expect(resolveTarget({ env: {}, profile })).toEqual({ accountId: "111", organizationId: "PROFIL" });
  });

  it("resolves each field on its own", () => {
    expect(resolveTarget({ flagAccount: "5", env: { EASYPARCEL_ORGANIZATION_ID: "77" }, profile })).toEqual({
      accountId: "5",
      organizationId: "77",
    });
  });

  it("returns no target when nothing is set, and ignores empty values", () => {
    expect(resolveTarget({ env: {} })).toEqual({ accountId: undefined, organizationId: undefined });
    expect(resolveTarget({ flagAccount: "", env: { EASYPARCEL_ACCOUNT_ID: "  " }, profile: {} })).toEqual({
      accountId: undefined,
      organizationId: undefined,
    });
  });

  it("rejects a non-numeric account with a usage error", () => {
    try {
      resolveTarget({ flagAccount: "12a", env: {} });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CliError);
      expect((e as CliError).exitCode).toBe(ExitCode.USAGE);
      expect((e as CliError).message).toContain("--account");
    }
    expect(() => resolveTarget({ env: { EASYPARCEL_ACCOUNT_ID: "-1" } })).toThrow(/EASYPARCEL_ACCOUNT_ID/);
  });

  it("accepts an organization id (digits) or a 6-letter uppercase ref only", () => {
    expect(validateOrganizationId("42")).toBe("42");
    expect(validateOrganizationId("QWERTY")).toBe("QWERTY");
    for (const bad of ["qwerty", "ABCDE", "ABCDEFG", "AB12CD", "x"]) {
      expect(() => validateOrganizationId(bad)).toThrow(CliError);
    }
  });
});

describe("targetHeaders", () => {
  it("emits only the headers that have a value", () => {
    expect(targetHeaders({})).toEqual({});
    expect(targetHeaders({ accountId: "1" })).toEqual({ "X-Account-Id": "1" });
    expect(targetHeaders({ accountId: "1", organizationId: "ABCDEF" })).toEqual({
      "X-Account-Id": "1",
      "X-Organization-Id": "ABCDEF",
    });
  });
});

describe("targetErrorHint", () => {
  it("turns ACCOUNT_HEADER_REQUIRED into the usage hint", () => {
    const hint = targetErrorHint({ status_code: 400, code: "ACCOUNT_HEADER_REQUIRED", message: "X-Account-Id required", data: null });
    expect(hint?.usage).toBe(true);
    expect(hint?.message).toContain(
      "This login covers all your accounts. Name one: `ep account list`, then `--account <id>` or `ep account use <id>`.",
    );
  });

  it("keeps the server message on the mapped refusals and leaves others alone", () => {
    for (const code of ["ACCOUNT_OWNER_REQUIRED", "ACCOUNT_FORBIDDEN", "ORGANIZATION_FORBIDDEN", "ORGANIZATION_HEADER_REQUIRED", "SWITCH_TOKEN_FORBIDDEN"]) {
      const hint = targetErrorHint({ status_code: 403, code, message: "server says no", data: null });
      expect(hint?.message).toContain("server says no");
      expect(hint?.message).not.toContain("\n");
    }
    expect(targetErrorHint({ status_code: 400, message: "bad", data: null })).toBeUndefined();
  });

  it("points MCP clients at the tools instead of CLI commands", () => {
    const hint = targetErrorHint({ status_code: 400, code: "ACCOUNT_HEADER_REQUIRED", data: null }, "mcp");
    expect(hint?.message).toContain("ep_account_list");
  });
});

describe("JWT helpers", () => {
  it("classes identity tokens by token_kind or a missing user.account_id", () => {
    expect(isIdentityToken(jwt({ token_kind: "identity", user: { id: "u" } }))).toBe(true);
    expect(isIdentityToken(jwt({ user: { id: "u" } }))).toBe(true);
    expect(isIdentityToken(jwt({ user: { id: "u", account_id: 5 } }))).toBe(false);
    expect(isIdentityToken("epat_opaque")).toBe(false);
    expect(isIdentityToken(undefined)).toBe(false);
  });

  it("detects an expired exp claim", () => {
    const now = Date.now();
    expect(isJwtExpired(jwt({ exp: Math.floor(now / 1000) - 10 }), now)).toBe(true);
    expect(isJwtExpired(jwt({ exp: Math.floor(now / 1000) + 600 }), now)).toBe(false);
    expect(isJwtExpired(jwt({}), now)).toBe(false);
    expect(isJwtExpired("epat_opaque", now)).toBe(false);
  });
});
