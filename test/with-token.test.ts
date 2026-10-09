import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { readStdinToken, prepareWithToken, maskToken, readHiddenToken } from "../src/cli/auth";
import { credentialsPath } from "../src/core/paths";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ep-wt-"));
  process.env.EASYPARCEL_CONFIG_DIR = tmp;
  delete process.env.EASYPARCEL_ACCESS_TOKEN;
  delete process.env.EASYPARCEL_TOKEN;
});

afterEach(() => {
  delete process.env.EASYPARCEL_CONFIG_DIR;
  delete process.env.EASYPARCEL_ACCESS_TOKEN;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("readStdinToken", () => {
  it("reads to EOF, trims surrounding whitespace, and never echoes the token", async () => {
    const token = "epat_secret_value_1234567890";
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const stream = Readable.from([Buffer.from("  " + token + "\n")]);
    const got = await readStdinToken(stream);

    expect(got).toBe(token);
    for (const call of [...stdout.mock.calls, ...stderr.mock.calls]) {
      expect(String(call[0])).not.toContain(token);
    }
    stdout.mockRestore();
    stderr.mockRestore();
  });
});

describe("prepareWithToken", () => {
  it("exposes the token in-process but writes NOTHING to disk", () => {
    const token = "epat_abc_def_ghijklmnop";
    const out = prepareWithToken(token);

    expect(out.token).toBe(token);
    expect(process.env.EASYPARCEL_ACCESS_TOKEN).toBe(token);
    // Never persisted: no credentials file is created by --with-token.
    expect(fs.existsSync(credentialsPath())).toBe(false);
  });

  it("rejects an empty / whitespace-only token", () => {
    expect(() => prepareWithToken("   \n")).toThrow();
  });
});

describe("maskToken", () => {
  it("shows only a short prefix and suffix", () => {
    expect(maskToken("epat_abcdefghijklmnop")).toBe("epat_a…op");
  });
  it("fully masks very short values", () => {
    expect(maskToken("short")).toBe("****");
  });
});

describe("readHiddenToken (interactive --with-token)", () => {
  it("returns the typed token without echoing it", async () => {
    const input = new PassThrough();
    let shown = "";
    const output = new PassThrough();
    output.on("data", (c) => (shown += c.toString()));
    const pending = readHiddenToken("? Paste a personal access token (epat_…): ", input, output);
    setImmediate(() => input.write("epat_s3cret_value\r"));
    await expect(pending).resolves.toBe("epat_s3cret_value");
    expect(shown).toContain("Paste a personal access token");
    expect(shown).not.toContain("s3cret");
  });
});
