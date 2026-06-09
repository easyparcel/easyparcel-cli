import { Command } from "commander";
import type { Operation } from "../operations/types";

/**
 * Attach the global options. Defined WITHOUT commander-level defaults so that
 * buildContext() owns precedence (flag > env > config > default) and
 * optsWithGlobals() merges cleanly whether a flag appears before or after the
 * subcommand. --no-color is root-only (it carries an implicit default that
 * would otherwise clobber a parent value when duplicated on leaves).
 */
export function addGlobalOptions(cmd: Command, opts: { includeColor?: boolean } = {}): Command {
  cmd
    .option("--profile <name>", "Credential profile to use")
    .option("--base-url <url>", "API base URL")
    .option("--api-version <version>", "API version prefix (e.g. 2026-03)")
    .option("-f, --format <format>", "Output format: json | pretty | table | ndjson | csv")
    .option("--data-only", "Print only the response `data`, not the full envelope")
    .option("--dry-run", "Mutating commands: print the request instead of sending it")
    .option("--fail-on-item-error", "Exit non-zero if any batch item fails")
    .option("--timeout <seconds>", "Request timeout in seconds")
    .option("--retries <n>", "Retry attempts on 429 / network errors")
    .option("--page-all", "Auto-paginate list endpoints (fetch every page)")
    .option("--page-limit <n>", "Max pages to fetch with --page-all")
    .option("--page-delay <ms>", "Delay between paginated requests (ms)")
    .option("-q, --quiet", "Suppress diagnostics on stderr")
    .option("-v, --verbose", "Verbose diagnostics on stderr");
  if (opts.includeColor) cmd.option("--no-color", "Disable colored output");
  return cmd;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

/** Build the "after help" text for an operation command. */
export function buildLongHelp(op: Operation): string {
  const lines: string[] = [];
  if (op.description) lines.push("", op.description);
  if (op.docNote) lines.push("", `Note: ${op.docNote}`);
  if (op.body !== "none") {
    lines.push("", "Request body: --data '<json>' | --data @file.json | --data -  (stdin)");
  }
  if (op.example !== undefined) {
    lines.push("", "Example body:", indent(JSON.stringify(op.example, null, 2)));
  }
  if (op.examples?.length) {
    lines.push("", "Examples:", ...op.examples.map((e) => "  " + e));
  }
  lines.push("", `Endpoint: ${op.method} /open_api/{version}/${op.path}`);
  return lines.join("\n");
}
