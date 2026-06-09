// Best-effort: download the native binary for this platform at install time.
// NON-FATAL — if it fails (offline, no release yet, etc.) the bundled JS CLI is
// used instead, so `npm install` always succeeds.
//
// Override the source with EASYPARCEL_CLI_BINARY_BASEURL, or skip entirely with
// EASYPARCEL_CLI_SKIP_DOWNLOAD=1.
import { existsSync, mkdirSync, createWriteStream, chmodSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

if (process.env.EASYPARCEL_CLI_SKIP_DOWNLOAD === "1") process.exit(0);

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

// Skip in the source repo (developer install) — the published package has no src/.
if (existsSync(join(pkgRoot, "src"))) process.exit(0);

let version = "0.0.0";
try {
  version = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
} catch {
  /* ignore */
}

const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const ext = osName === "windows" ? ".exe" : "";
const asset = `easyparcel-${osName}-${arch}${ext}`;
const destDir = join(pkgRoot, "dist", "bin");
const dest = join(destDir, asset);

if (existsSync(dest)) process.exit(0); // already present (e.g. local build)

const base =
  process.env.EASYPARCEL_CLI_BINARY_BASEURL ||
  `https://github.com/easyparcel/easyparcel-cli/releases/download/v${version}`;
const url = `${base}/${asset}`;

function download(u, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(u, { headers: { "User-Agent": "easyparcel-cli" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          resolve(download(res.headers.location, file, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const out = createWriteStream(file);
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

mkdirSync(destDir, { recursive: true });
download(url, dest)
  .then(() => {
    if (ext === "") {
      try {
        chmodSync(dest, 0o755);
      } catch {
        /* ignore */
      }
    }
    process.stderr.write(`easyparcel-cli: installed native binary (${asset}).\n`);
  })
  .catch((err) => {
    try {
      if (existsSync(dest)) unlinkSync(dest);
    } catch {
      /* ignore */
    }
    process.stderr.write(
      `easyparcel-cli: native binary not downloaded (${err.message}); the CLI will run via Node.\n`,
    );
    process.exit(0); // non-fatal
  });
