import { Command } from "commander";
import { getContext } from "../core/context";
import { addGlobalOptions } from "./global";
import { resolveData } from "./input";
import { apiRequest, type HttpMethod } from "../core/client";
import { reportEnvelope } from "./run";
import { CliError, ExitCode } from "../core/errors";

/** Parse repeated `--header "Name: value"` flags into a header map (usage error on a bad entry). */
export function parseHeaderFlags(values: string[] = []): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of values) {
    const i = raw.indexOf(":");
    const name = i > 0 ? raw.slice(0, i).trim() : "";
    if (!name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new CliError(`Invalid --header '${raw}'. Use "Name: value", e.g. --header "X-Account-Id: 123".`, ExitCode.USAGE);
    }
    headers[name] = raw.slice(i + 1).trim();
  }
  return headers;
}

/** Layer 3 — call any endpoint directly. */
export function registerApi(program: Command): void {
  const api = program
    .command("api")
    .argument("<method>", "HTTP method: GET, POST, PUT, DELETE")
    .argument("<path>", "Path, e.g. shipment/quotations (auto-versioned) or an absolute URL")
    .description("Call any EasyParcel API endpoint directly (raw passthrough)")
    .option("-d, --data <json>", "Request body: JSON string, @file, or - for stdin")
    .option("--query <json>", "Query parameters as a JSON object")
    .option("--header <k:v>", "Extra request header \"Name: value\" (repeatable)", (v: string, prev: string[] = []) => [...prev, v])
    .option("--no-auth", "Do not send the Authorization header")
    .option("--no-version", "Do not auto-prefix /open_api/{version}/");

  addGlobalOptions(api);

  api.addHelpText(
    "after",
    [
      "",
      "Examples:",
      `  ep api POST shipment/quotations --data '{"shipment":[...]}'`,
      "  ep api GET wallet",
      `  ep api GET courier/list --data '{"country_code":"MY"}'   # GET-with-body`,
      "  ep api GET /open_api/2026-03/account/get_account_information --no-version",
      '  ep api GET wallet --header "X-Account-Id: 123456"',
    ].join("\n"),
  );

  api.action(async (method: string, path: string, opts: Record<string, any>) => {
    const ctx = getContext();
    const verb = method.toUpperCase();
    const allowed = ["GET", "POST", "PUT", "DELETE", "PATCH"];
    if (!allowed.includes(verb)) {
      throw new CliError(`Unsupported HTTP method '${method}'. Use one of: ${allowed.join(", ")}.`, ExitCode.USAGE);
    }
    const body = await resolveData(opts.data as string | undefined);
    const query = opts.query ? ((await resolveData(opts.query as string)) as Record<string, any>) : undefined;
    const headers = parseHeaderFlags(opts.header as string[] | undefined);
    const env = await apiRequest(ctx, {
      method: verb as HttpMethod,
      path,
      body,
      query,
      headers,
      auth: opts.auth !== false,
      versioned: opts.version !== false,
    });
    reportEnvelope(ctx, env);
  });
}
