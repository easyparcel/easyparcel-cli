import { Command } from "commander";
import { spawn } from "node:child_process";
import { rawRequest } from "../core/http";
import { CLI_VERSION, PACKAGE_NAME } from "../core/version";
import { printJson } from "../core/output";
import { log } from "../core/logger";

const RELEASES_URL =
  process.env.EASYPARCEL_CLI_RELEASES_URL || "https://github.com/easyparcel/easyparcel-cli/releases/latest";

/** How was this CLI installed/run? */
function installKind(): "npm" | "binary" {
  // Running the JS bundle under Node => installed via npm.
  if (!(process.versions as Record<string, string>).bun) return "npm";
  // Running the bun-compiled binary: npm-delivered if it lives inside node_modules,
  // otherwise it's a standalone download.
  return (process.execPath || "").includes("node_modules") ? "npm" : "binary";
}

/** Compare two dotted versions: 1 if a>b, -1 if a<b, 0 if equal. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await rawRequest(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "easyparcel-cli" },
      timeoutMs: 15000,
    });
    if (res.status !== 200) return null;
    const json = JSON.parse(res.body) as { version?: string };
    return json.version ?? null;
  } catch {
    return null;
  }
}

async function upgradeAction(opts: Record<string, any>): Promise<void> {
  const current = CLI_VERSION;
  log.info("Checking for updates…");
  const latest = await fetchLatestVersion();

  if (latest) {
    const upToDate = cmpVersion(latest, current) <= 0;
    if (upToDate && !opts.to) {
      log.info(`Already up to date (v${current}).`);
      printJson({ current, latest, up_to_date: true });
      return;
    }
    log.info(`Update available: v${current} → v${latest}`);
  } else {
    log.warn("Couldn't reach the npm registry to check the latest version.");
  }

  if (opts.check) {
    printJson({ current, latest, up_to_date: latest ? cmpVersion(latest, current) <= 0 : null });
    return;
  }

  const kind = installKind();

  if (kind === "binary") {
    log.warn("This is a standalone binary — it can't replace itself. Download the latest from:");
    process.stderr.write("\n  " + RELEASES_URL + "\n\n");
    printJson({ current, latest, install: "binary", action: "manual_download", url: RELEASES_URL });
    return;
  }

  // npm-managed (pure JS or npm-delivered binary): re-run a global install.
  const target = `${PACKAGE_NAME}@${opts.to || "latest"}`;
  log.info(`Updating via npm: npm i -g ${target}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npm, ["install", "-g", target], { stdio: "inherit" });
  child.on("error", (e) => {
    log.error(`Could not run npm (${(e as Error).message}). Update manually: npm i -g ${target}`);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    if (code === 0) log.info("Updated. Run `ep --version` to confirm.");
    process.exitCode = code ?? 0;
  });
}

/** `ep upgrade` (alias `ep update`) — self-update the CLI. */
export function registerUpgrade(program: Command): void {
  program
    .command("upgrade")
    .alias("update")
    .description("Update the CLI to the latest version")
    .option("--check", "Only check whether an update is available (don't install)")
    .option("--to <version>", "Install a specific version (npm installs only)")
    .action(upgradeAction);
}
