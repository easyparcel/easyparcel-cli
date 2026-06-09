import os from "node:os";
import path from "node:path";

/** Root config directory. Override with EASYPARCEL_CONFIG_DIR. */
export function configDir(): string {
  return process.env.EASYPARCEL_CONFIG_DIR || path.join(os.homedir(), ".easyparcel");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function credentialsPath(): string {
  return path.join(configDir(), "credentials.json");
}
