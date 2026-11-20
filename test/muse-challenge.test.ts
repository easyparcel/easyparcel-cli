import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHttpMcpServer, museChallengeTokens, MUSE_CHALLENGES_ENV, type HttpMcpServerHandle } from "../src/mcp/http";
import { buildContext } from "../src/core/context";

const TOKEN = "88f50b1704920de1a68e97feed2e0e1b47f4eb8398f9f2b7cfaf099ca589d2f4";
let tmp: string;
let h: HttpMcpServerHandle;
let base: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-muse-"));
  process.env.EASYPARCEL_CONFIG_DIR = tmp;
  buildContext({ quiet: true });
  process.env[MUSE_CHALLENGES_ENV] = `other-token-1234567890, ${TOKEN}`;
  h = await startHttpMcpServer({ port: 0, host: "127.0.0.1", path: "/mcp", requireAuth: true, oauth: false });
  base = `http://127.0.0.1:${h.port}`;
});

afterAll(async () => {
  await h.close();
  delete process.env[MUSE_CHALLENGES_ENV];
  delete process.env.EASYPARCEL_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("muse challenge", () => {
  it("serves a configured token as plain text without auth", async () => {
    const res = await fetch(`${base}/.well-known/muse-challenge/${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect((await res.text()).trim()).toBe(`muse-challenge=${TOKEN}`);
  });

  it("404s an unknown token", async () => {
    const res = await fetch(`${base}/.well-known/muse-challenge/deadbeefdeadbeefdeadbeef`);
    expect(res.status).toBe(404);
  });

  it("ignores malformed entries", () => {
    expect([...museChallengeTokens(" ,short, ../etc/passwd ,abcdef0123456789abcdef ")]).toEqual(["abcdef0123456789abcdef"]);
    expect(museChallengeTokens(undefined).size).toBe(0);
  });
});
