import { Command } from "commander";
import { CLI_VERSION } from "./core/version";
import { buildContext } from "./core/context";
import { CliError, ExitCode } from "./core/errors";
import { log } from "./core/logger";
import { addGlobalOptions } from "./cli/global";
import { registerAuth } from "./cli/auth";
import { registerOperations } from "./cli/register";
import { registerShortcuts } from "./cli/shortcuts";
import { registerApi } from "./cli/api";
import { registerDescribe } from "./cli/describe";
import { registerReference } from "./cli/reference";
import { registerConfig } from "./cli/config";
import { registerMcp } from "./cli/mcp";
import { registerSkills } from "./cli/skills";
import { registerUpgrade } from "./cli/upgrade";

function buildProgram(): Command {
  const program = new Command();

  program
    .name("easyparcel")
    .description("EasyParcel CLI — comprehensive EasyParcel Open API client for humans and AI agents")
    .version(CLI_VERSION, "-V, --version", "Print the CLI version")
    .showSuggestionAfterError()
    .configureHelp({ showGlobalOptions: true });

  addGlobalOptions(program, { includeColor: true });

  // Resolve runtime context (flag > env > config > default) before any action.
  program.hook("preAction", (_thisCommand, actionCommand) => {
    buildContext(actionCommand.optsWithGlobals());
  });

  registerAuth(program);
  registerOperations(program);
  registerShortcuts(program);
  registerApi(program);
  registerDescribe(program);
  registerReference(program);
  registerConfig(program);
  registerMcp(program);
  registerSkills(program);
  registerUpgrade(program);

  program.addHelpText(
    "after",
    `
Three layers (choose your granularity):
  Shortcuts   ep +rates --from 11950 --to 55100 --weight 1
  Commands    ep shipment quote --data '{...}'      (also top-level: ep quote, ep track, ep wallet)
  Raw API     ep api POST shipment/quotations --data '{...}'

For AI agents:
  ep describe                 List every operation + JSON schema (machine-readable)
  ep mcp                      Run an MCP server exposing all operations as tools

Authentication:
  ep auth login               Browser OAuth2 + PKCE  (or set EASYPARCEL_ACCESS_TOKEN for headless use)
  ep auth status              Show current auth state

Output: --format json|pretty|table|ndjson|csv   ·   --data-only   ·   --dry-run (mutating cmds)
Exit codes: 0 ok · 2 usage · 3 auth · 4 not-found · 5 validation · 6 rate-limited · 7 item-errors · 8 network
`,
  );

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();

  // No arguments → show help.
  if (process.argv.slice(2).length === 0) {
    program.outputHelp();
    return;
  }

  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof CliError) {
      log.error(e.message);
      if (e.details !== undefined) log.debug(`details: ${JSON.stringify(e.details)}`);
      process.exitCode = e.exitCode;
    } else {
      const err = e as Error;
      log.error(err?.message ?? String(e));
      if (process.env.EASYPARCEL_DEBUG) log.error(err?.stack ?? "");
      process.exitCode = ExitCode.GENERIC;
    }
  }
}

void main();
