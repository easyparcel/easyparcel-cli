import { describe, it, expect } from "vitest";
import { planAccountSync, accountIdFromToken } from "../src/cli/auth";

const jwt = (claims: object) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");

describe("ep auth sync — planAccountSync", () => {
  it("adds owned accounts that have no profile, keeps the ones that do, reports stale profiles", () => {
    const accounts = [
      { account_id: 1, name: "Main", is_current: true },
      { account_id: 2, name: "SG" },
      { account_id: 3, name: "New shop" },
    ];
    const profiles = {
      default: { account_id: 1 },
      sg: { access_token: jwt({ user: { id: "x", account_id: 2 } }) }, // older profile: account read from the token
      old: { account_id: 9 },
    };
    const plan = planAccountSync(accounts, profiles);
    expect(plan.add).toEqual([{ account_id: 3, name: "New shop" }]);
    expect(plan.existing).toEqual([
      { account_id: 1, profile: "default" },
      { account_id: 2, profile: "sg" },
    ]);
    expect(plan.stale).toEqual([{ account_id: "9", profile: "old" }]);
  });

  it("treats numeric and string ids as the same account", () => {
    const plan = planAccountSync([{ account_id: "42", name: "A" }], { a: { account_id: 42 } });
    expect(plan.add).toEqual([]);
    expect(plan.existing).toEqual([{ account_id: "42", profile: "a" }]);
  });

  it("ignores profiles whose token has no account claim", () => {
    const plan = planAccountSync([{ account_id: 1 }], { env: { access_token: "not-a-jwt" }, idOnly: { access_token: jwt({ user: { id: "u" } }) } });
    expect(plan.add).toEqual([{ account_id: 1, name: undefined }]);
    expect(plan.stale).toEqual([]);
  });
});

describe("accountIdFromToken", () => {
  it("reads user.account_id from the JWT payload and tolerates garbage", () => {
    expect(accountIdFromToken(jwt({ user: { id: "enc", account_id: 187874 } }))).toBe(187874);
    expect(accountIdFromToken("garbage")).toBeUndefined();
    expect(accountIdFromToken(undefined)).toBeUndefined();
  });
});
