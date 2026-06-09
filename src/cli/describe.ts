import { Command } from "commander";
import { OPERATIONS, getOperation, mcpToolName, GROUP_SUMMARY } from "../operations";
import { getContext } from "../core/context";
import { addGlobalOptions } from "./global";
import { printJson } from "../core/output";
import { CliError, ExitCode } from "../core/errors";

/**
 * Machine-readable catalog so AI agents can introspect every operation,
 * its endpoint, whether it mutates, and its request-body JSON Schema.
 */
export function registerDescribe(program: Command): void {
  const d = program
    .command("describe")
    .alias("schema")
    .argument("[operation]", "Operation id or command (e.g. shipment.quote, quote)")
    .description("List all operations, or print one operation's schema (machine-readable)")
    .action((operation?: string) => {
      const ctx = getContext();
      if (!operation) {
        printJson({
          api_version: ctx.apiVersion,
          base_url: ctx.baseUrl,
          groups: GROUP_SUMMARY,
          operations: OPERATIONS.map((o) => ({
            id: o.id,
            group: o.group,
            command: o.command,
            top_level_alias: o.topLevelAlias ?? null,
            method: o.method,
            path: o.path,
            mutating: Boolean(o.mutating),
            body: o.body,
            body_required: Boolean(o.bodyRequired),
            paginated: Boolean(o.pagination),
            summary: o.summary,
            mcp_tool: mcpToolName(o),
          })),
        });
        return;
      }
      const op = getOperation(operation);
      if (!op) {
        throw new CliError(`Unknown operation '${operation}'. Run 'ep describe' to list them.`, ExitCode.USAGE);
      }
      printJson({
        id: op.id,
        group: op.group,
        command: op.command,
        aliases: op.aliases ?? [],
        top_level_alias: op.topLevelAlias ?? null,
        method: op.method,
        path: op.path,
        endpoint: `${op.method} /open_api/{version}/${op.path}`,
        mutating: Boolean(op.mutating),
        body: op.body,
        body_required: Boolean(op.bodyRequired),
        paginated: Boolean(op.pagination),
        summary: op.summary,
        description: op.description ?? null,
        doc_note: op.docNote ?? null,
        schema: op.schema ?? null,
        example: op.example ?? null,
        examples: op.examples ?? [],
        mcp_tool: mcpToolName(op),
      });
    });

  addGlobalOptions(d);
}
