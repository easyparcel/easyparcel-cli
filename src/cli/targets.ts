import { Command } from "commander";
import { getContext, type RuntimeContext } from "../core/context";
import { addGlobalOptions } from "./global";
import { apiRequest } from "../core/client";
import { updateProfileMetadata } from "../core/credentials";
import { CliError, ExitCode } from "../core/errors";
import { effectiveStatus } from "../core/envelope";
import { log } from "../core/logger";
import { printJson } from "../core/output";
import { targetErrorHint, validateAccountId, validateOrganizationId } from "../core/target";

/** Fetch a target-free listing (list_accounts / organization/list) or fail with the server's reason. */
async function fetchList(ctx: RuntimeContext, path: string, what: string): Promise<any[]> {
  const env = await apiRequest(ctx, { method: "GET", path, target: false });
  if (effectiveStatus(env) >= 400 || !Array.isArray(env.data)) {
    const reason = targetErrorHint(env)?.message || env.message || `HTTP ${env.status_code}`;
    throw new CliError(`Could not list your ${what} to check the id: ${reason}. Pass --force to store it anyway.`, ExitCode.AUTH);
  }
  return env.data as any[];
}

/** `ep account use <id>` / `--clear`: store (or drop) the profile's default account. Exported for tests. */
export async function useAccount(
  ctx: RuntimeContext,
  id: string | undefined,
  opts: { clear?: boolean; force?: boolean },
): Promise<Record<string, unknown>> {
  if (opts.clear) {
    updateProfileMetadata(ctx.profile, { default_account_id: undefined });
    return { status: "ok", profile: ctx.profile, default_account_id: null };
  }
  if (id === undefined) throw new CliError("Name an account: `ep account use <id>` (see `ep account list`), or pass --clear.", ExitCode.USAGE);
  const accountId = validateAccountId(id);
  let match: any;
  if (!opts.force) {
    const accounts = await fetchList(ctx, "account/list_accounts", "accounts");
    match = accounts.find((a) => String(a?.account_id) === accountId);
    if (!match) {
      throw new CliError(
        `Account ${accountId} is not in \`ep account list\` for profile '${ctx.profile}'. Pass --force to store it anyway.`,
        ExitCode.USAGE,
      );
    }
    if (match.token_usable === false) log.warn(`Account ${accountId} is listed but not usable with this login right now (token_usable: false).`);
  }
  updateProfileMetadata(ctx.profile, { default_account_id: Number(accountId) });
  return {
    status: "ok",
    profile: ctx.profile,
    default_account_id: Number(accountId),
    ...(match?.name !== undefined ? { name: match.name } : {}),
    verified: !opts.force,
  };
}

/** `ep org use <id|ref>` / `--clear`: store (or drop) the profile's default organization. Exported for tests. */
export async function useOrganization(
  ctx: RuntimeContext,
  id: string | undefined,
  opts: { clear?: boolean; force?: boolean },
): Promise<Record<string, unknown>> {
  if (opts.clear) {
    updateProfileMetadata(ctx.profile, { default_organization_id: undefined });
    return { status: "ok", profile: ctx.profile, default_organization_id: null };
  }
  if (id === undefined) throw new CliError("Name an organization: `ep org use <id|ref>` (see `ep org list`), or pass --clear.", ExitCode.USAGE);
  const orgId = validateOrganizationId(id);
  let match: any;
  if (!opts.force) {
    const orgs = await fetchList(ctx, "organization/list", "organizations");
    match = orgs.find((o) => String(o?.organization_id ?? o?.id) === orgId || String(o?.ref) === orgId);
    if (!match) {
      throw new CliError(
        `Organization ${orgId} is not in \`ep org list\` for profile '${ctx.profile}'. Pass --force to store it anyway.`,
        ExitCode.USAGE,
      );
    }
  }
  updateProfileMetadata(ctx.profile, { default_organization_id: orgId });
  return {
    status: "ok",
    profile: ctx.profile,
    default_organization_id: orgId,
    ...(match?.name !== undefined ? { name: match.name } : {}),
    verified: !opts.force,
  };
}

function groupCommand(program: Command, name: string): Command {
  const cmd = program.commands.find((c) => c.name() === name);
  if (!cmd) throw new Error(`command group '${name}' is not registered`);
  return cmd;
}

/** `ep account use` and `ep org use` (+ the `org` alias); call after registerOperations. */
export function registerTargetCommands(program: Command): void {
  const account = groupCommand(program, "account");
  addGlobalOptions(
    account
      .command("use")
      .argument("[id]", "Account id from `ep account list`")
      .description("Set this profile's default account (sent as X-Account-Id when --account is not given)")
      .option("--clear", "Remove the default account")
      .option("--force", "Store the id without checking it against `ep account list`"),
  ).action(async (id: string | undefined, opts: Record<string, any>) => {
    printJson(await useAccount(getContext(), id, { clear: opts.clear, force: opts.force }));
  });

  const org = groupCommand(program, "organization");
  org.alias("org");
  addGlobalOptions(
    org
      .command("use")
      .argument("[id]", "Organization id or 6-letter ref from `ep org list`")
      .description("Set this profile's default organization (sent as X-Organization-Id when --organization is not given)")
      .option("--clear", "Remove the default organization")
      .option("--force", "Store the id without checking it against `ep org list`"),
  ).action(async (id: string | undefined, opts: Record<string, any>) => {
    printJson(await useOrganization(getContext(), id, { clear: opts.clear, force: opts.force }));
  });
}
