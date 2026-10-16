import { Command } from "commander";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
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
  requestDeviceAuthorization,
  describeDevice,
  pollForDeviceToken,
  revokeToken,
  detectHeadless,
  currentHeadlessSignals,
} from "../core/oauth";
import {
  getProfileCredentials,
  setProfileCredentials,
  clearProfile,
  listProfiles,
  loadStore,
  hasEnvAccessToken,
} from "../core/credentials";
import { keychainAvailable } from "../core/keychain";
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
async function authorizeAllAccounts(
  ctx: RuntimeContext,
  baseTr: TokenResponse,
  client: ClientCreds,
  grant: string,
): Promise<void> {
  // Persist the base token so apiRequest can authenticate the enumerate/switch calls.
  setProfileCredentials(
    ctx.profile,
    tokensFromResponse(baseTr, { client_id: client.clientId, client_secret: client.clientSecret }),
  );

  const listEnv = await apiRequest(ctx, { method: "GET", path: "account/list_accounts" });
  const accounts = Array.isArray(listEnv.data) ? (listEnv.data as any[]) : [];
  if (accounts.length === 0) {
    log.warn("No accounts returned; kept the single login.");
    persistLogin(ctx, baseTr, client, grant);
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
    grant,
    default_profile: current ? current.profile : null,
    accounts: created,
  });
}

async function finishLogin(
  ctx: RuntimeContext,
  tr: TokenResponse,
  client: ClientCreds,
  all: boolean,
  grant: string,
): Promise<void> {
  if (all) await authorizeAllAccounts(ctx, tr, client, grant);
  else persistLogin(ctx, tr, client, grant);
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

/** Mask a token for display so it is never printed in full. */
export function maskToken(t: string): string {
  if (t.length <= 8) return "****";
  return t.slice(0, 6) + "…" + t.slice(-2);
}

/** Read a token from a stream (default stdin) to EOF, trimmed. Never echoes. */
export async function readStdinToken(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Validate a stdin-provided personal access token and make it available to THIS
 * process (never written to the keychain or disk). The caller reuses it across
 * invocations via EASYPARCEL_TOKEN / EASYPARCEL_ACCESS_TOKEN.
 */
export function prepareWithToken(raw: string): { token: string; masked: string } {
  const token = raw.trim();
  if (!token) {
    throw new CliError(
      "No token received on stdin. Pipe a token: `printf %s \"$EASYPARCEL_TOKEN\" | ep login --with-token`.",
      ExitCode.USAGE,
    );
  }
  // In-process only; getProfileCredentials() overlays this and maybePersist() skips writing.
  process.env.EASYPARCEL_ACCESS_TOKEN = token;
  return { token, masked: maskToken(token) };
}

/**
 * Prompt for a token on a terminal without echoing it. readline writes through a sink that
 * passes on only the prompt, so the characters typed after it never reach the screen.
 */
export async function readHiddenToken(
  prompt: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) output.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: input as NodeJS.ReadableStream & { fd?: number }, output: sink, terminal: true });
  const abort = new AbortController();
  rl.on("SIGINT", () => abort.abort());
  try {
    const answer = rl.question(prompt, { signal: abort.signal });
    muted = true;
    return (await answer).trim();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new CliError("Cancelled.", ExitCode.USAGE);
    throw e;
  } finally {
    rl.close();
    output.write("\n");
  }
}

async function withTokenLogin(ctx: RuntimeContext, opts: Record<string, any>): Promise<void> {
  let raw: string;
  if (process.stdin.isTTY) {
    if (opts.nonInteractive) {
      throw new CliError(
        "--with-token reads the token from stdin. Pipe it in: `printf %s \"$EASYPARCEL_TOKEN\" | ep login --with-token`.",
        ExitCode.USAGE,
      );
    }
    raw = await readHiddenToken("? Paste a personal access token (epat_…): ");
  } else {
    raw = await readStdinToken();
  }
  const { token, masked } = prepareWithToken(raw);
  if (!token.startsWith("epat_")) {
    log.warn("Token does not start with 'epat_'; personal access tokens use that prefix. Continuing.");
  }
  let verified: boolean | null = null;
  if (opts.verify !== false) {
    try {
      // Verify THIS token: passing it explicitly also disables the 401 → refresh retry, which
      // would otherwise answer with the stored profile's refresh token and report a bad token as fine.
      const env = await apiRequest(ctx, { method: "GET", path: "account/get_account_information", accessToken: token });
      verified = (env.status_code ?? 0) < 400;
    } catch {
      verified = false;
    }
  }
  printJson({
    status: "ok",
    grant: "personal_access_token",
    profile: ctx.profile,
    persisted: false,
    token: masked,
    verified,
    note: "Token is NOT written to disk. Set EASYPARCEL_TOKEN (or EASYPARCEL_ACCESS_TOKEN) to reuse it.",
  });
}

async function deviceLogin(
  ctx: RuntimeContext,
  client: ClientCreds,
  o: { scope?: string; all: boolean; json: boolean },
): Promise<void> {
  const da = await requestDeviceAuthorization({
    baseUrl: ctx.baseUrl,
    clientId: client.clientId,
    scope: o.scope,
    // The label on the approval page. The default carries the machine's host name; set
    // EASYPARCEL_DEVICE_NAME to show something else.
    deviceName: process.env.EASYPARCEL_DEVICE_NAME?.trim() || describeDevice(),
  });
  // Human prompt on stderr (stdout stays clean for the final result JSON).
  log.info("To sign in, open the URL on any device and enter the code:");
  process.stderr.write(`\n  URL:  ${da.verification_uri}\n  Code: ${da.user_code}\n`);
  if (da.verification_uri_complete) {
    process.stderr.write(`\n  Or open directly: ${da.verification_uri_complete}\n`);
  }
  process.stderr.write("\nWaiting for authorization…\n");
  // stdout carries exactly one JSON object (the final result), so the pending notice an
  // agent needs to relay the code goes to stderr.
  if (o.json) {
    process.stderr.write(
      JSON.stringify({
        status: "authorization_pending",
        grant: "device_code",
        user_code: da.user_code,
        verification_uri: da.verification_uri,
        verification_uri_complete: da.verification_uri_complete ?? null,
        expires_in: da.expires_in,
        interval: da.interval,
      }) + "\n",
    );
  }
  const tr = await pollForDeviceToken({
    baseUrl: ctx.baseUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    deviceCode: da.device_code,
    interval: da.interval,
    expiresIn: da.expires_in,
  });
  await finishLogin(ctx, tr, client, o.all, "device_code");
}

async function loginAction(opts: Record<string, any>): Promise<void> {
  const ctx = getContext();
  const scope: string | undefined = opts.scope;
  const jsonMode = Boolean(opts.json);
  const nonInteractive = Boolean(opts.nonInteractive);

  // --- --with-token: read an epat_ token from stdin (never persisted) ---
  if (opts.withToken) {
    await withTokenLogin(ctx, opts);
    return;
  }

  const client = resolveClient(ctx, opts);

  // Every remaining flow except client_credentials waits for a person (browser or device
  // approval), which is exactly what --non-interactive promises not to do.
  if (nonInteractive && !opts.clientCredentials) {
    throw new CliError(
      "--non-interactive cannot wait for a browser or device approval. Pipe a token with --with-token, or use --client-credentials for a confidential app.",
      ExitCode.USAGE,
    );
  }

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

  // --- device authorization grant (explicit --device, or auto when headless) ---
  const useDevice =
    opts.device === true ? true : opts.device === false ? false : detectHeadless(currentHeadlessSignals());
  if (useDevice) {
    await deviceLogin(ctx, client, { scope, all: Boolean(opts.all), json: jsonMode });
    return;
  }

  // The server matches redirect URIs exactly and the CLI app registers only port 8788, so
  // another port only works together with --redirect-uri on an app that registered it.
  const port = opts.port != null ? Number(opts.port) : DEFAULT_CALLBACK_PORT;
  if (port !== DEFAULT_CALLBACK_PORT && !opts.redirectUri) {
    log.warn(`Port ${port} is not registered for this app; the server will reject the callback unless --redirect-uri names a registered URI.`);
  }
  const state = randomState();
  const pkce = generatePkce();
  const waitMs = Number(opts.wait ?? 300) * 1000;

  // --- manual paste (headless / no reachable loopback) ---
  // NOTE: commander maps --no-browser to opts.browser === false (not opts.noBrowser).
  if (opts.browser === false) {
    if (nonInteractive) {
      throw new CliError(
        "--no-browser needs an interactive paste. Pipe a token with --with-token for non-interactive login.",
        ExitCode.USAGE,
      );
    }
    const redirectUri = opts.redirectUri || `http://localhost:${port || DEFAULT_CALLBACK_PORT}/callback`;
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
    await finishLogin(ctx, tr, client, Boolean(opts.all), "authorization_code");
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
    await finishLogin(ctx, tr, client, Boolean(opts.all), "authorization_code");
  } finally {
    server.close();
  }
}

function tokenSource(profile: string): "env" | "store" | "none" {
  if (
    process.env.EASYPARCEL_ACCESS_TOKEN ||
    process.env.EASYPARCEL_TOKEN ||
    process.env.EASYPARCEL_REFRESH_TOKEN
  ) {
    return "env";
  }
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
    // Where THIS profile's tokens live, not what the machine could do.
    storage: loadStore().profiles[ctx.profile]?.storage ?? (keychainAvailable() ? "keychain" : "file"),
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

/**
 * Server-side revoke THEN local clear. Revocation is best-effort: its failure
 * must never block clearing the local credential. Exported for unit testing the
 * ordering/robustness with injected callbacks.
 */
export async function logoutSequence(opts: {
  refreshToken?: string;
  revoke: (rt: string) => Promise<boolean>;
  clear: () => boolean;
}): Promise<{ revoked: boolean; cleared: boolean }> {
  let revoked = false;
  if (opts.refreshToken) {
    try {
      revoked = await opts.revoke(opts.refreshToken);
    } catch {
      revoked = false; // best-effort; proceed to clear regardless
    }
  }
  const cleared = opts.clear();
  return { revoked, cleared };
}

async function logoutAction(opts: Record<string, any>): Promise<void> {
  const ctx = getContext();
  const creds = getProfileCredentials(ctx.profile);
  const client = resolveClient(ctx, opts);

  const { revoked, cleared } = await logoutSequence({
    refreshToken: creds.refresh_token,
    revoke: (rt) =>
      revokeToken({
        baseUrl: ctx.baseUrl,
        token: rt,
        tokenTypeHint: "refresh_token",
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      }),
    clear: () => clearProfile(ctx.profile),
  });

  if (hasEnvAccessToken() || process.env.EASYPARCEL_REFRESH_TOKEN) {
    log.warn(
      "Environment tokens (EASYPARCEL_ACCESS_TOKEN/EASYPARCEL_TOKEN/EASYPARCEL_REFRESH_TOKEN) are still set and will continue to be used.",
    );
  }
  printJson({
    status: cleared ? "logged_out" : "no_stored_credentials",
    profile: ctx.profile,
    revoked,
  });
}

async function whoamiAction(): Promise<void> {
  const ctx = getContext();
  const env = await apiRequest(ctx, { method: "GET", path: "account/get_account_information" });
  printJson(ctx.dataOnly ? env.data : env);
  if ((env.status_code ?? 0) >= 400) process.exitCode = ExitCode.AUTH;
}

/** Attach the shared `login` options (used by both `ep login` and `ep auth login`). */
function attachLoginOptions(cmd: Command): Command {
  return cmd
    .option("--client-id <id>", "Override the built-in OAuth client id")
    .option("--client-secret <secret>", "OAuth client secret (only for confidential/custom apps)")
    .option("--device", "Use the device authorization grant (RFC 8628); auto-selected when headless/SSH")
    .option("--no-device", "Force the browser flow even when headless")
    .option("--with-token", "Read a personal access token (epat_) from stdin; never written to disk")
    .option("--no-verify", "Skip the server verification call for --with-token")
    .option("--client-credentials", "Use the client_credentials grant (no browser)")
    .option("--all", "Authorize ALL accounts you belong to and save one profile per account")
    .option("--no-browser", "Print the URL and paste the redirect code back (headless)")
    .option("--redirect-uri <uri>", "Override the redirect URI (must be registered)")
    .option("--port <port>", `Loopback callback port (default ${DEFAULT_CALLBACK_PORT}, the only port registered for the built-in app; others need --redirect-uri)`)
    .option("--scope <scope>", "OAuth scope (usually empty for this API)")
    .option("--json", "Emit machine-readable JSON status (for agents/CI)")
    .option("--non-interactive", "Never prompt; fail instead of waiting for interactive input")
    .option("--wait <seconds>", "Seconds to wait for browser authorization", "300");
}

const LOGIN_DESCRIPTION =
  `Sign in to EasyParcel. Default: browser OAuth2 + PKCE on loopback port ${DEFAULT_CALLBACK_PORT}. ` +
  "Use --device for a no-browser device code (auto over SSH), or --with-token for a piped epat_ token.";

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Authenticate and manage credentials / profiles");

  addGlobalOptions(attachLoginOptions(auth.command("login").description(LOGIN_DESCRIPTION))).action(loginAction);

  addGlobalOptions(auth.command("status").description("Show authentication status for the active profile")).action(
    statusAction,
  );
  addGlobalOptions(auth.command("refresh").description("Force an access-token refresh")).action(refreshAction);
  addGlobalOptions(
    auth
      .command("logout")
      .description("Revoke the refresh token server-side, then clear local credentials")
      .option("--client-id <id>", "OAuth client id for the revoke call")
      .option("--client-secret <secret>", "OAuth client secret for the revoke call")
      .option("--json", "Emit machine-readable JSON status"),
  ).action(logoutAction);
  addGlobalOptions(auth.command("whoami").description("Fetch the connected account profile")).action(whoamiAction);

  // Top-level aliases (match the spec's `ep login` / `ep logout`).
  addGlobalOptions(attachLoginOptions(program.command("login").description(LOGIN_DESCRIPTION))).action(loginAction);
  addGlobalOptions(
    program
      .command("logout")
      .description("Revoke the refresh token server-side, then clear local credentials")
      .option("--client-id <id>", "OAuth client id for the revoke call")
      .option("--client-secret <secret>", "OAuth client secret for the revoke call")
      .option("--json", "Emit machine-readable JSON status"),
  ).action(logoutAction);
}
