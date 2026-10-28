import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/core/client", async (orig) => ({
  ...(await orig<typeof import("../src/core/client")>()),
  apiRequest: vi.fn(),
}));

import { apiRequest } from "../src/core/client";
import { buildContext } from "../src/core/context";
import { accountRows } from "../src/operations/account";
import { organizationRows } from "../src/operations/organization";
import { getOperation } from "../src/operations";
import { renderTable, makeColor } from "../src/core/output";
import { runOperation } from "../src/cli/run";
import { useAccount, useOrganization } from "../src/cli/targets";
import { warnDeprecatedMultiProfile, loginTargetFields } from "../src/cli/auth";
import { credentialsPath } from "../src/core/paths";
import { CliError, ExitCode } from "../src/core/errors";

const api = vi.mocked(apiRequest);
let tmp: string;

const ACCOUNTS = [
  { account_id: 101, name: "Main shop", account_type: "business", is_current: false, organization_id: 9, base_country: "MY", token_usable: true },
  { account_id: 202, name: "SG branch", account_type: "personal", base_country: "SG", token_usable: false },
  { account_id: 303 }, // older server: only some fields
];
const ORGS = [
  { organization_id: 9, ref: "QWERTY", name: "Acme", role: "owner", is_default: true, products: { whatsapp: true, ai_agent: false } },
  { organization_id: 10, name: "Beta" },
];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-target-"));
  process.env.EASYPARCEL_CONFIG_DIR = tmp;
  for (const k of ["EASYPARCEL_ACCOUNT_ID", "EASYPARCEL_ORGANIZATION_ID", "EASYPARCEL_PROFILE", "EASYPARCEL_ACCESS_TOKEN", "EASYPARCEL_TOKEN"]) delete process.env[k];
  api.mockReset();
  api.mockImplementation(async (_ctx, opts) => ({
    status_code: 200,
    data: opts.path === "organization/list" ? ORGS : ACCOUNTS,
  }));
});

afterEach(() => {
  delete process.env.EASYPARCEL_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("human tables", () => {
  it("renders accounts with the contract columns and tolerates missing fields", () => {
    const rows = accountRows(ACCOUNTS, { defaultAccountId: "202" });
    const out = renderTable(rows, getOperation("account.list")!.humanTable!.columns, makeColor(false));
    const lines = out.split("\n");
    expect(lines[0].split("|").map((s) => s.trim())).toEqual(["ACCOUNT_ID", "NAME", "TYPE", "COUNTRY", "CURRENCY", "DEFAULT", "ORGANISATION", "TOKEN_USABLE"]);
    expect(lines[2]).toMatch(/101\s+\|\s+Main shop\s+\|\s+business\s+\|\s+MY\s+\|\s+MYR\s+\|\s+\|\s+9\s+\|\s+yes\s*$/);
    expect(lines[3]).toMatch(/202 .*SG branch.*\|\s+SGD\s+\|\s+\*\s+\|\s+\|\s+no\s*$/);
    expect(lines[4]).toMatch(/^ 303 /);
  });

  it("renders organizations with the contract columns", () => {
    const out = renderTable(organizationRows(ORGS), getOperation("organization.list")!.humanTable!.columns, makeColor(false));
    const lines = out.split("\n");
    expect(lines[0].split("|").map((s) => s.trim())).toEqual(["ORG_ID", "REF", "NAME", "ROLE", "WHATSAPP", "AI_AGENT"]);
    expect(lines[2]).toMatch(/9\s+\|\s+QWERTY\s+\|\s+Acme\s+\|\s+owner\s+\|\s+yes\s+\|\s+no/);
    expect(lines[3]).toMatch(/10 .*Beta/);
  });

  it("`ep account list --format table` prints the table, not the envelope, and sends no target", async () => {
    const ctx = buildContext({ format: "table", quiet: true, account: "101" });
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((c: any) => (out.push(String(c)), true));
    try {
      await runOperation(ctx, getOperation("account.list")!);
    } finally {
      spy.mockRestore();
    }
    expect(out.join("")).toContain("CURRENCY");
    expect(out.join("")).not.toContain("status_code");
    expect(api.mock.calls[0][1]).toMatchObject({ path: "account/list_accounts", target: false });
  });
});

describe("ep account use / ep org use", () => {
  const stored = () => JSON.parse(fs.readFileSync(credentialsPath(), "utf8")).profiles.default;

  it("stores a listed account as the profile default, which then becomes the request target", async () => {
    const ctx = buildContext({ quiet: true });
    const res = await useAccount(ctx, "101", {});
    expect(res).toMatchObject({ status: "ok", default_account_id: 101, name: "Main shop", verified: true });
    expect(stored().default_account_id).toBe(101);
    expect(buildContext({ quiet: true }).accountId).toBe("101");
    // flag and env still win over the stored default
    expect(buildContext({ quiet: true, account: "202" }).accountId).toBe("202");
    process.env.EASYPARCEL_ACCOUNT_ID = "303";
    expect(buildContext({ quiet: true }).accountId).toBe("303");
  });

  it("refuses an unlisted account unless --force, and validates the id", async () => {
    const ctx = buildContext({ quiet: true });
    await expect(useAccount(ctx, "999", {})).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
    expect(fs.existsSync(credentialsPath())).toBe(false);
    await expect(useAccount(ctx, "abc", { force: true })).rejects.toBeInstanceOf(CliError);
    const forced = await useAccount(ctx, "999", { force: true });
    expect(forced).toMatchObject({ default_account_id: 999, verified: false });
    expect(api).toHaveBeenCalledTimes(1); // --force skipped the listing
  });

  it("--clear removes the default and keeps the rest of the profile", async () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      credentialsPath(),
      JSON.stringify({ version: 1, profiles: { default: { identity: true, default_account_id: 101, storage: "keychain" } } }),
    );
    const res = await useAccount(buildContext({ quiet: true }), undefined, { clear: true });
    expect(res).toEqual({ status: "ok", profile: "default", default_account_id: null });
    expect(stored()).toEqual({ identity: true, storage: "keychain" });
  });

  it("stores an organization by id or ref after checking the list", async () => {
    const ctx = buildContext({ quiet: true });
    await useOrganization(ctx, "QWERTY", {});
    expect(stored().default_organization_id).toBe("QWERTY");
    expect(buildContext({ quiet: true }).organizationId).toBe("QWERTY");
    await useOrganization(ctx, "10", {});
    expect(stored().default_organization_id).toBe("10");
    await expect(useOrganization(ctx, "ZZZZZZ", {})).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
    await useOrganization(ctx, undefined, { clear: true });
    expect(stored().default_organization_id).toBeUndefined();
  });

  it("explains a failed listing and suggests --force", async () => {
    api.mockResolvedValueOnce({ status_code: 401, message: "Invalid Access Token", data: null });
    await expect(useAccount(buildContext({ quiet: true }), "101", {})).rejects.toThrow(/--force/);
  });
});

describe("deprecation notice", () => {
  it("prints once per process", () => {
    buildContext({});
    const err: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: any) => (err.push(String(c)), true));
    try {
      warnDeprecatedMultiProfile();
      warnDeprecatedMultiProfile();
    } finally {
      spy.mockRestore();
    }
    const text = err.join("");
    expect(text.match(/`--all` and `ep auth sync` are deprecated/g)).toHaveLength(1);
    expect(text).toContain("pass --account <id>");
  });
});

describe("login target fields (persistLogin)", () => {
  const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

  it("marks an identity token and stores no account_id", () => {
    const f = loginTargetFields(jwt({ token_kind: "identity", user: { id: "u", easy_account_id: "e" } }));
    expect(f).toEqual({ identity: true, account_id: undefined });
    expect(loginTargetFields(jwt({ user: { id: "u" } })).identity).toBe(true);
  });

  it("keeps the bound account for an account-bound token", () => {
    expect(loginTargetFields(jwt({ user: { id: "u", account_id: 187874 } }))).toEqual({ identity: undefined, account_id: 187874 });
  });
});
