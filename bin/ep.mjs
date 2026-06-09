#!/usr/bin/env node
// Launcher: prefer the platform-native binary (fast, downloaded at install time),
// otherwise fall back to the bundled JS CLI (always present). This gives npm users
// native speed when available, while never failing if the binary isn't there.
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

function nativeBinaryPath() {
  const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const ext = osName === "windows" ? ".exe" : "";
  return join(pkgRoot, "dist", "bin", `easyparcel-${osName}-${arch}${ext}`);
}

function runBundledJs() {
  // We're already running under Node here, so importing the ESM bundle runs the CLI
  // with the current process.argv intact.
  import(pathToFileURL(join(pkgRoot, "dist", "index.js")).href).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

const bin = nativeBinaryPath();
if (existsSync(bin)) {
  let fellBack = false;
  const child = spawn(bin, process.argv.slice(2), { stdio: "inherit" });
  child.on("error", () => {
    if (!fellBack) {
      fellBack = true;
      runBundledJs();
    }
  });
  child.on("exit", (code, signal) => {
    if (fellBack) return;
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  runBundledJs();
}
