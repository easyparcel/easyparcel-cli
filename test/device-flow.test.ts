import { describe, it, expect } from "vitest";
import { interpretDeviceToken, pollForDeviceToken } from "../src/core/oauth";

const noSleep = () => Promise.resolve();

describe("interpretDeviceToken (RFC 8628 state machine)", () => {
  it("approves when an access_token is present", () => {
    expect(interpretDeviceToken(200, { access_token: "a", token_type: "Bearer" })).toEqual({
      status: "approved",
      token: { access_token: "a", token_type: "Bearer" },
    });
  });

  it("unwraps a { data: { access_token } } envelope", () => {
    expect(interpretDeviceToken(200, { data: { access_token: "z", token_type: "Bearer" } }).status).toBe("approved");
  });

  it("maps the four standard polling errors", () => {
    expect(interpretDeviceToken(400, { error: "authorization_pending" }).status).toBe("pending");
    expect(interpretDeviceToken(400, { error: "slow_down" }).status).toBe("slow_down");
    expect(interpretDeviceToken(400, { error: "access_denied" }).status).toBe("denied");
    expect(interpretDeviceToken(400, { error: "expired_token" }).status).toBe("expired");
  });

  it("falls through to a generic error for anything else", () => {
    expect(interpretDeviceToken(400, { error: "invalid_client", error_description: "bad" })).toMatchObject({
      status: "error",
      error: "invalid_client",
      description: "bad",
    });
  });
});

describe("pollForDeviceToken", () => {
  it("polls pending → slow_down → approved and backs the interval off by 5s", async () => {
    const responses = [
      { status: 400, json: { error: "authorization_pending" } },
      { status: 400, json: { error: "slow_down" } },
      { status: 200, json: { access_token: "tok", token_type: "Bearer" } },
    ];
    let i = 0;
    const ticks: number[] = [];
    const token = await pollForDeviceToken({
      baseUrl: "https://api.test",
      clientId: "c",
      deviceCode: "dc",
      interval: 5,
      expiresIn: 600,
      sleep: noSleep,
      poster: async () => responses[i++],
      onTick: (n) => ticks.push(n),
    });
    expect(token.access_token).toBe("tok");
    expect(ticks).toEqual([5, 10]); // pending at 5, slow_down bumps to 10
    expect(i).toBe(3);
  });

  it("rejects with an AUTH error when the device authorization is denied", async () => {
    await expect(
      pollForDeviceToken({
        baseUrl: "x",
        clientId: "c",
        deviceCode: "dc",
        interval: 1,
        expiresIn: 600,
        sleep: noSleep,
        poster: async () => ({ status: 400, json: { error: "access_denied" } }),
      }),
    ).rejects.toThrow(/denied/i);
  });

  it("rejects when the server reports expired_token", async () => {
    await expect(
      pollForDeviceToken({
        baseUrl: "x",
        clientId: "c",
        deviceCode: "dc",
        interval: 1,
        expiresIn: 600,
        sleep: noSleep,
        poster: async () => ({ status: 400, json: { error: "expired_token" } }),
      }),
    ).rejects.toThrow(/expired/i);
  });

  it("rejects once the overall expiry deadline passes", async () => {
    let t = 0;
    const now = () => (t += 1000); // +1s every call; expiresIn=1 → deadline reached on the first loop check
    await expect(
      pollForDeviceToken({
        baseUrl: "x",
        clientId: "c",
        deviceCode: "dc",
        interval: 1,
        expiresIn: 1,
        sleep: noSleep,
        now,
        poster: async () => ({ status: 400, json: { error: "authorization_pending" } }),
      }),
    ).rejects.toThrow(/expired/i);
  });
});
