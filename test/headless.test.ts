import { describe, it, expect } from "vitest";
import { detectHeadless, type HeadlessSignals } from "../src/core/oauth";

const base: HeadlessSignals = {
  env: {},
  platform: "linux",
  stdoutIsTTY: true,
  stderrIsTTY: true,
};

describe("detectHeadless (auto-select the device grant)", () => {
  it("is headless over SSH, even on a GUI platform", () => {
    expect(detectHeadless({ ...base, platform: "darwin", env: { SSH_CONNECTION: "1 2 3 4" } })).toBe(true);
  });

  it("is headless on Linux with no DISPLAY / WAYLAND_DISPLAY", () => {
    expect(detectHeadless({ ...base, platform: "linux", env: {} })).toBe(true);
  });

  it("is interactive on Linux with a DISPLAY and a TTY", () => {
    expect(detectHeadless({ ...base, platform: "linux", env: { DISPLAY: ":0" } })).toBe(false);
  });

  it("is interactive on a macOS desktop", () => {
    expect(detectHeadless({ ...base, platform: "darwin", env: {} })).toBe(false);
  });

  it("is interactive on a Windows desktop", () => {
    expect(detectHeadless({ ...base, platform: "win32", env: {} })).toBe(false);
  });

  it("is headless when there is no controlling terminal at all", () => {
    expect(
      detectHeadless({ env: {}, platform: "win32", stdoutIsTTY: false, stderrIsTTY: false }),
    ).toBe(true);
  });
});
