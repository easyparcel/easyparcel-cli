import { Command } from "commander";
import * as readline from "node:readline/promises";
import { getContext } from "../core/context";
import { addGlobalOptions } from "./global";
import { CliError, ExitCode } from "../core/errors";
import { log } from "../core/logger";
import { printJson } from "../core/output";
import { DEFAULT_CALLBACK_PORT, DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, loadConfig, saveConfig } from "../core/config";
import {
  startLoopbackServer,
  buildAuthUrl,
  generatePkce,
  randomState,
  openUrl,
  exchangeCode,
  clientCredentials,
} from "../core/oauth";
import {
  getProfileCredentials,
  setProfileCredentials,
  clearProfile,
  listProfiles,
  loadStore,
} from "../core/credentials";
import { tokensFromResponse, doRefresh, isExpired } from "../core/tokens";
import { apiRequest } from "../core/client";
import type { RuntimeContext } from "../core/context";
import type { TokenResponse } from "../core/types";

interface ClientCreds {
  clientId: string;
  clientSecret?: string;
}

function resolveClient(ctx: RuntimeContext, opts: Record<string, any>): ClientCreds {
  const stored = getProfileCredentials(ctx.profile);
  // Precedence: flag > env > stored > config override > built-in public client.
  const clientId =
    opts.clientId ||
    process.env.EASYPARCEL_CLIENT_ID ||
    stored.client_id ||
    ctx.config.client_id ||
    DEFAULT_CLIENT_ID;
  let clientSecret = opts.clientSecret || process.env.EASYPARCEL_CLIENT_SECRET || stored.client_secret;
  // Use the built-in secret only when running as the built-in client.
  if (!clientSecret && clientId === DEFAULT_CLIENT_ID && DEFAULT_CLIENT_SECRET) {
    clientSecret = DEFAULT_CLIENT_SECRET;
  }
  if (!clientId) {
    throw new CliError(
      "No OAuth client id available. Pass --client-id, set EASYPARCEL_CLIENT_ID, or run `ep config set client_id <id>`.",
      ExitCode.USAGE,
    );
  }
  return { clientId, clientSecret };
}

function persistLogin(ctx: RuntimeContext, tr: TokenResponse, client: ClientCreds, grant: string): void {
  setProfileCredentials(
    ctx.profile,
    tokensFromResponse(tr, { client_id: client.clientId, client_secret: client.clientSecret }),
  );
  log.info(`Authenticated profile '${ctx.profile}' via ${grant}.`);
  printJson({
    status: "ok",
    profile: ctx.profile,
    grant,
    token_type: tr.token_type,
    expires_at: tr.expires_at ?? (tr.expires_in ? new Date(Date.now() + tr.expires_in * 1000).toISOString() : null),
    has_refresh_token: Boolean(tr.refresh_token),
  });
}

function slugify(name: unknown): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueSlug(name: unknown, accountId: unknown, used: Set<string>): string {
  const base = slugify(name) || `acc-${accountId}`;
  let slug = base;
  let n = 2;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

/**
 * After one interactive login, enumerate every account the user belongs to and
 * mint + store a token (profile) for each, via the core list_accounts /
 * switch_token endpoints. Sets the current account as the default profile.
 */
async function authorizeAllAccounts(ctx: RuntimeContext, baseTr: TokenResponse, client: ClientCreds): Promise<void> {
  // Persist the base token so apiRequest can authenticate the enumerate/switch calls.
  setProfileCredentials(
    ctx.profile,
    tokensFromResponse(baseTr, { client_id: client.clientId, client_secret: client.clientSecret }),
  );

  const listEnv = await apiRequest(ctx, { method: "GET", path: "account/list_accounts" });
  const accounts = Array.isArray(listEnv.data) ? (listEnv.data as any[]) : [];
  if (accounts.length === 0) {
    log.warn("No accounts returned; kept the single login.");
    persistLogin(ctx, baseTr, client, "authorization_code");
    return;
  }

  const used = new Set<string>();
  const created: Array<{ account: string; account_id: unknown; profile: string; current: boolean }> = [];
  for (const acc of accounts) {
    const slug = uniqueSlug(acc.name, acc.account_id, used);
    let tr: TokenResponse;
    if (acc.is_current) {
      tr = baseTr;
    } else {
      const env = await apiRequest(ctx, {
        method: "POST",
        path: "account/switch_token",
        body: { account_id: acc.account_id },
      });
      const data = env.data as any;
      if ((env.status_code ?? 0) >= 400 || !data || !data.access_token) {
        log.warn(`skipped '${acc.name}' (${acc.account_id}): ${env.message || "could not mint token"}`);
        continue;
      }
      tr = data as TokenResponse;
    }
    setProfileCredentials(
      slug,
      tokensFromResponse(tr, { client_id: client.clientId, client_secret: client.clientSecret, account_label: String(acc.name) }),
    );
    created.push({ account: acc.name, account_id: acc.account_id, profile: slug, current: Boolean(acc.is_current) });
  }

  const current = created.find((c) => c.current) || created[0];
  if (current) {
    const cfg = loadConfig();
    cfg.default_profile = current.profile;
    saveConfig(cfg);
  }
  log.info(`Authorized ${created.length} account(s). Default profile: '${current ? current.profile : ctx.profile}'.`);
  printJson({
    status: "ok",
    grant: "authorization_code",
    default_profile: current ? current.profile : null,
    accounts: created,
  });
}

async function finishLogin(ctx: RuntimeContext, tr: TokenResponse, client: ClientCreds, all: boolean): Promise<void> {
  if (all) await authorizeAllAccounts(ctx, tr, client);
  else persistLogin(ctx, tr, client, "authorization_code");
}

function parsePasted(v: string): { code?: string; state?: string } {
  if (v.includes("code=") || v.startsWith("http")) {
    try {
      const q = v.includes("?") ? v.slice(v.indexOf("?")) : "?" + v;
      const params = new URLSearchParams(q);
      return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
    } catch {
      /* fall through */
    }
  }
  return { code: v || undefined };
}

async function loginAction(opts: Record<string, any>): Promise<void> {
  const ctx = getContext();
  const client = resolveClient(ctx, opts);
  const scope: string | undefined = opts.scope;

  // --- client_credentials: no browser at all ---
  if (opts.clientCredentials) {
    if (!client.clientSecret) {
      throw new CliError(
        "client_credentials grant requires --client-secret (or EASYPARCEL_CLIENT_SECRET).",
        ExitCode.USAGE,
      );
    }
    log.info("Requesting token via client_credentials grant…");
    const tr = await clientCredentials({
      baseUrl: ctx.baseUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      scope,
    });
    persistLogin(ctx, tr, client, "client_credentials");
    return;
  }

  const port = Number(opts.port ?? DEFAULT_CALLBACK_PORT);
  const state = randomState();
  const pkce = generatePkce();
  const waitMs = Number(opts.wait ?? 300) * 1000;

  // --- manual paste (headless / no reachable loopback) ---
  if (opts.noBrowser) {
    const redirectUri = opts.redirectUri || `http://localhost:${port}/callback`;
    const url = buildAuthUrl({ baseUrl: ctx.baseUrl, clientId: client.clientId, redirectUri, challenge: pkce.challenge, state, scope });
    log.info("Open this URL in a browser to authorize:");
    process.stderr.write("\n  " + url + "\n\n");
    log.info(`(Ensure ${redirectUri} is a registered redirect URI for your app.)`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const pasted = (await rl.question("Paste the full redirect URL (or just the code): ")).trim();
    rl.close();
    const { code, state: retState } = parsePasted(pasted);
    if (retState && retState !== state) log.warn("state mismatch in pasted value — continuing anyway.");
    if (!code) throw new CliError("No authorization code found in the pasted value.", ExitCode.AUTH);
    const tr = await exchangeCode({
      baseUrl: ctx.baseUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri,
      code,
      codeVerifier: pkce.verifier,
      state,
    });
    await finishLogin(ctx, tr, client, Boolean(opts.all));
    return;
  }

  // --- browser + loopback callback ---
  const server = await startLoopbackServer({ state, port });
  const redirectUri = opts.redirectUri || server.redirectUri;
  const url = buildAuthUrl({ baseUrl: ctx.baseUrl, clientId: client.clientId, redirectUri, challenge: pkce.challenge, state, scope });
  log.info(`Waiting for authorization on ${server.redirectUri}`);
  log.info("Opening your browser… if it does not open, visit this URL:");
  process.stderr.write("\n  " + url + "\n\n");
  openUrl(url);
  try {
    const { code } = await server.waitForCode(waitMs);
    const tr = await exchangeCode({
      baseUrl: ctx.baseUrl,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri,
      code,
      codeVerifier: pkce.verifier,
      state,
    });
    await finishLogin(ctx, tr, client, Boolean(opts.all));
  } finally {
    server.close();
  }
}

function tokenSource(profile: string): "env" | "store" | "none" {
  if (process.env.EASYPARCEL_ACCESS_TOKEN || process.env.EASYPARCEL_REFRESH_TOKEN) return "env";
  return loadStore().profiles[profile] ? "store" : "none";
}

function statusAction(): void {
  const ctx = getContext();
  const creds = getProfileCredentials(ctx.profile);
  const authenticated = Boolean(creds.access_token || creds.refresh_token);
  printJson({
    profile: ctx.profile,
    base_url: ctx.baseUrl,
    api_version: ctx.apiVersion,
    authenticated,
    token_source: tokenSource(ctx.profile),
    has_access_token: Boolean(creds.access_token),
    has_refresh_token: Boolean(creds.refresh_token),
    expires_at: creds.expires_at ?? null,
    access_token_expired: creds.access_token ? isExpired(creds.expires_at) : null,
    profiles: listProfiles(),
  });
  if (!authenticated) process.exitCode = ExitCode.AUTH;
}

async function refreshAction(): Promise<void> {
  const ctx = getContext();
  const creds = getProfileCredentials(ctx.profile);
  if (!creds.refresh_token) {
    throw new CliError("No refresh token for this profile. Run `ep auth login`.", ExitCode.AUTH);
  }
  const token = await doRefresh(ctx, creds);
  if (!token) throw new CliError("Token refresh failed. Run `ep auth login` again.", ExitCode.AUTH);
  const updated = getProfileCredentials(ctx.profile);
  printJson({ status: "ok", profile: ctx.profile, expires_at: updated.expires_at ?? null });
}

function logoutAction(): void {
  const ctx = getContext();
  const removed = clearProfile(ctx.profile);
  if (process.env.EASYPARCEL_ACCESS_TOKEN || process.env.EASYPARCEL_REFRESH_TOKEN) {
    log.warn("Environment tokens (EASYPARCEL_ACCESS_TOKEN/REFRESH_TOKEN) are still set and will continue to be used.");
  }
  printJson({ status: removed ? "logged_out" : "no_stored_credentials", profile: ctx.profile });
}

async function whoamiAction(): Promise<void> {
  const ctx = getContext();
  const env = await apiRequest(ctx, { method: "GET", path: "account/get_account_information" });
  printJson(ctx.dataOnly ? env.data : env);
  if ((env.status_code ?? 0) >= 400) process.exitCode = ExitCode.AUTH;
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Authenticate and manage credentials / profiles");

  addGlobalOptions(
    auth
      .command("login")
      .description("Authenticate via browser (OAuth2 + PKCE). Uses the built-in CLI app by default — just run `ep auth login`.")
      .option("--client-id <id>", "Override the built-in OAuth client id")
      .option("--client-secret <secret>", "OAuth client secret (only for confidential/custom apps)")
      .option("--client-credentials", "Use the client_credentials grant (no browser)")
      .option("--all", "Authorize ALL accounts you belong to and save one profile per account")
      .option("--no-browser", "Print the URL and paste the redirect code back (headless)")
      .option("--redirect-uri <uri>", "Override the redirect URI (must be registered)")
      .option("--port <port>", `Loopback callback port (default ${DEFAULT_CALLBACK_PORT})`)
      .option("--scope <scope>", "OAuth scope (usually empty for this API)")
      .option("--wait <seconds>", "Seconds to wait for browser authorization", "300"),
  ).action(loginAction);

  addGlobalOptions(auth.command("status").description("Show authentication status for the active profile")).action(
    statusAction,
  );
  addGlobalOptions(auth.command("refresh").description("Force an access-token refresh")).action(refreshAction);
  addGlobalOptions(auth.command("logout").description("Remove stored credentials for the active profile")).action(
    logoutAction,
  );
  addGlobalOptions(auth.command("whoami").description("Fetch the connected account profile")).action(whoamiAction);
}
