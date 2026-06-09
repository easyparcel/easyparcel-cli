import { Command } from "commander";
import { getContext } from "../core/context";
import { addGlobalOptions } from "./global";
import { resolveData } from "./input";
import { apiRequest, type HttpMethod } from "../core/client";
import { reportEnvelope } from "./run";
import { CliError, ExitCode } from "../core/errors";

/** Layer 3 — call any endpoint directly. */
export function registerApi(program: Command): void {
  const api = program
    .command("api")
    .argument("<method>", "HTTP method: GET, POST, PUT, DELETE")
    .argument("<path>", "Path, e.g. shipment/quotations (auto-versioned) or an absolute URL")
    .description("Call any EasyParcel API endpoint directly (raw passthrough)")
    .option("-d, --data <json>", "Request body: JSON string, @file, or - for stdin")
    .option("--query <json>", "Query parameters as a JSON object")
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
    const env = await apiRequest(ctx, {
      method: verb as HttpMethod,
      path,
      body,
      query,
      auth: opts.auth !== false,
      versioned: opts.version !== false,
    });
    reportEnvelope(ctx, env);
  });
}
