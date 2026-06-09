import { Command } from "commander";
import { OPERATIONS, GROUPS, GROUP_SUMMARY, operationsByGroup } from "../operations";
import type { Operation } from "../operations/types";
import { getContext } from "../core/context";
import { resolveData } from "./input";
import { runOperation } from "./run";
import { addGlobalOptions, buildLongHelp } from "./global";

function attachAction(cmd: Command, op: Operation): void {
  cmd.summary(op.summary);
  cmd.description(op.description || op.summary);
  if (op.body !== "none") {
    cmd.option("-d, --data <json>", "Request body: JSON string, @file, or - for stdin");
  }
  addGlobalOptions(cmd);
  cmd.addHelpText("after", buildLongHelp(op));
  cmd.action(async (opts: Record<string, unknown>) => {
    const ctx = getContext();
    const body = op.body !== "none" ? await resolveData(opts.data as string | undefined) : undefined;
    await runOperation(ctx, op, { body });
  });
}

/** Register all API operations as grouped commands plus top-level aliases. */
export function registerOperations(program: Command): void {
  for (const group of GROUPS) {
    const groupCmd = program.command(group).description(GROUP_SUMMARY[group]);
    for (const op of operationsByGroup(group)) {
      const sub = groupCmd.command(op.command);
      if (op.aliases) for (const a of op.aliases) sub.alias(a);
      attachAction(sub, op);
    }
  }

  // Top-level convenience aliases (e.g. `ep quote`, `ep track`, `ep wallet`).
  for (const op of OPERATIONS) {
    if (!op.topLevelAlias) continue;
    const top = program.command(op.topLevelAlias);
    attachAction(top, op);
    top.description(`${op.summary}  (alias for: ep ${op.group} ${op.command})`);
  }
}
