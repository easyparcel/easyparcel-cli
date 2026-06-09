// Build standalone, single-file executables (no Node runtime required) for every
// platform using `bun build --compile`. Run with: npm run build:exe
//
// Output: dist/bin/easyparcel-<os>-<arch>[.exe]
// Each is a self-contained binary — users can run it directly, like lark-cli.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const ENTRY = "src/index.ts";
const OUT_DIR = "dist/bin";

const targets = [
  { target: "bun-windows-x64", out: `${OUT_DIR}/easyparcel-windows-x64.exe` },
  { target: "bun-darwin-arm64", out: `${OUT_DIR}/easyparcel-darwin-arm64` },
  { target: "bun-darwin-x64", out: `${OUT_DIR}/easyparcel-darwin-x64` },
  { target: "bun-linux-x64", out: `${OUT_DIR}/easyparcel-linux-x64` },
  { target: "bun-linux-arm64", out: `${OUT_DIR}/easyparcel-linux-arm64` },
];

mkdirSync(OUT_DIR, { recursive: true });

// Ensure embedded skills are up to date before compiling.
spawnSync("node", ["scripts/generate-skills.mjs"], { stdio: "inherit" });

let failed = 0;
for (const { target, out } of targets) {
  process.stderr.write(`\n▶ building ${target} -> ${out}\n`);
  const r = spawnSync(
    "bun",
    ["build", ENTRY, "--compile", `--target=${target}`, "--outfile", out],
    { stdio: "inherit", shell: true },
  );
  if (r.status !== 0) {
    failed++;
    process.stderr.write(`✗ ${target} failed (exit ${r.status})\n`);
  } else {
    process.stderr.write(`✓ ${target}\n`);
  }
}

process.stderr.write(`\nDone. ${targets.length - failed}/${targets.length} binaries built into ${OUT_DIR}/.\n`);
process.exit(failed ? 1 : 0);
