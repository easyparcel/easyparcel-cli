import { describe, it, expect, vi } from "vitest";
import { logoutSequence } from "../src/cli/auth";

describe("logoutSequence (revoke then clear)", () => {
  it("revokes server-side BEFORE clearing local storage", async () => {
    const order: string[] = [];
    const res = await logoutSequence({
      refreshToken: "RT",
      revoke: async () => {
        order.push("revoke");
        return true;
      },
      clear: () => {
        order.push("clear");
        return true;
      },
    });
    expect(order).toEqual(["revoke", "clear"]);
    expect(res).toEqual({ revoked: true, cleared: true });
  });

  it("still clears when the revoke call fails (best-effort)", async () => {
    const clear = vi.fn(() => true);
    const res = await logoutSequence({
      refreshToken: "RT",
      revoke: async () => {
        throw new Error("network down");
      },
      clear,
    });
    expect(clear).toHaveBeenCalledOnce();
    expect(res).toEqual({ revoked: false, cleared: true });
  });

  it("skips revoke entirely when there is no refresh token", async () => {
    const revoke = vi.fn(async () => true);
    const res = await logoutSequence({ refreshToken: undefined, revoke, clear: () => false });
    expect(revoke).not.toHaveBeenCalled();
    expect(res).toEqual({ revoked: false, cleared: false });
  });
});
