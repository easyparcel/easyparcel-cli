import { Command } from "commander";
import { loadConfig, saveConfig } from "../core/config";
import { configDir, configPath, credentialsPath } from "../core/paths";
import { listProfiles } from "../core/credentials";
import { printJson } from "../core/output";
import { CliError, ExitCode } from "../core/errors";
import type { EpConfig } from "../core/types";

const SETTABLE: (keyof EpConfig)[] = ["base_url", "api_version", "default_profile", "client_id"];

export function registerConfig(program: Command): void {
  const cfg = program.command("config").description("Manage CLI configuration (~/.easyparcel/config.json)");

  cfg
    .command("show")
    .alias("list")
    .description("Print the current configuration")
    .action(() => printJson({ ...loadConfig(), profiles: listProfiles() }));

  cfg
    .command("path")
    .description("Print config / credential file locations")
    .action(() => printJson({ dir: configDir(), config: configPath(), credentials: credentialsPath() }));

  cfg
    .command("get")
    .argument("<key>", "Config key")
    .description("Read a config value")
    .action((key: string) => {
      const c = loadConfig() as unknown as Record<string, unknown>;
      printJson({ [key]: c[key] ?? null });
    });

  cfg
    .command("set")
    .argument("<key>", `One of: ${SETTABLE.join(", ")}`)
    .argument("<value>", "New value")
    .description("Write a config value")
    .action((key: string, value: string) => {
      if (!SETTABLE.includes(key as keyof EpConfig)) {
        throw new CliError(`Unknown config key '${key}'. Settable: ${SETTABLE.join(", ")}`, ExitCode.USAGE);
      }
      const c = loadConfig();
      (c as unknown as Record<string, unknown>)[key] = value;
      saveConfig(c);
      printJson(c);
    });
}
