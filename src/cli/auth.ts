import { Command } from "commander";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import { getContext } from "../core/context";
import { addGlobalOptions } from "./global";
import { CliError, ExitCode, exitCodeForStatus } from "../core/errors";
import { log } from "../core/logger";
import { printJson } from "../core/output";
import { DEFAULT_CALLBACK_PORT, DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, MCP_BROKER_CLIENT_ID, loadConfig, saveConfig } from "../core/config";
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
  deviceOpensBrowser,
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
import { tokensFromResponse, doRefresh, isExpired, SIGNED_OUT_MESSAGE } from "../core/tokens";
import { apiRequest } from "../core/client";
import { decodeJwtPayload, isIdentityToken, isJwtExpired } from "../core/jwt";
import { DEFAULT_PROFILE } from "../core/config";
import type { ProfileCredentials } from "../core/types";
import type { RuntimeContext } from "../core/context";
import type { TokenResponse } from "../core/types";

interface ClientCreds {
  clientId: string;
  clientSecret?: string;
}

export function resolveClient(ctx: RuntimeContext, opts: Record<string, any>): ClientCreds {
  const stored = getProfileCredentials(ctx.profile);
  // A client id stored by an older CLI (≤ 0.1.10 defaulted to the hosted broker's confidential
  // app) must not drive a NEW login: the device grant refuses it as non-public. Only an explicit
  // flag or env may still name it.
  const legacyStored = stored.client_id === MCP_BROKER_CLIENT_ID;
  if (legacyStored && !opts.clientId && !process.env.EASYPARCEL_CLIENT_ID) {
    log.warn(`Ignoring the client id stored by an older CLI version (${MCP_BROKER_CLIENT_ID.slice(0, 8)}…); signing in as the EasyParcel CLI app.`);
  }
  const storedClientId = legacyStored ? undefined : stored.client_id;
  // Precedence: flag > env > stored (unless legacy) > config override > built-in public client.
  const clientId =
    opts.clientId ||
    process.env.EASYPARCEL_CLIENT_ID ||
    storedClientId ||
    ctx.config.client_id ||
    DEFAULT_CLIENT_ID;
  let clientSecret = opts.clientSecret || process.env.EASYPARCEL_CLIENT_SECRET || (storedClientId ? stored.client_secret : undefined);
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

/** The shipping account a token is bound to, read from the access JWT's own claims (no network). */
export function accountIdFromToken(accessToken?: string): number | string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split(".")[1], "base64url").toString("utf8"));
    const id = payload?.user?.account_id;
    return id === undefined || id === null || id === "" ? undefined : id;
  } catch {
    return undefined;
  }
}

/**
 * Decide what `ep auth sync` has to do: owned accounts with no profile get one, profiles whose
 * account is no longer owned are reported (never deleted). Pure, so it is unit-testable.
 */
export function planAccountSync(
  accounts: Array<{ account_id: number | string; name?: unknown; is_current?: boolean }>,
  profiles: Record<string, { account_id?: number | string; access_token?: string }>,
): {
  add: Array<{ account_id: number | string; name?: unknown }>;
  existing: Array<{ account_id: number | string; profile: string }>;
  stale: Array<{ account_id: number | string; profile: string }>;
} {
  const byAccount = new Map<string, string>();
  for (const [profile, rec] of Object.entries(profiles)) {
    const id = rec.account_id ?? accountIdFromToken(rec.access_token);
    if (id !== undefined && !byAccount.has(String(id))) byAccount.set(String(id), profile);
  }
  const owned = new Set(accounts.map((a) => String(a.account_id)));
  return {
    add: accounts.filter((a) => !byAccount.has(String(a.account_id))).map((a) => ({ account_id: a.account_id, name: a.name })),
    existing: accounts.filter((a) => byAccount.has(String(a.account_id))).map((a) => ({ account_id: a.account_id, profile: byAccount.get(String(a.account_id))! })),
    stale: [...byAccount.entries()].filter(([id]) => !owned.has(id)).map(([id, profile]) => ({ account_id: id, profile })),
  };
}

const DEPRECATION_NOTICE =
  "`--all` and `ep auth sync` are deprecated and will be removed in a future release. Instead sign in once with `ep login` " +
  "(choose \"All my shipping accounts\" on the approval page), list them with `ep account list`, then pass --account <id> " +
  "or store a default with `ep account use <id>`.";
let deprecationShown = false;

/** Print the `--all` / `auth sync` deprecation once per process (stderr). */
export function warnDeprecatedMultiProfile(): void {
  if (deprecationShown) return;
  deprecationShown = true;
  log.warn(DEPRECATION_NOTICE);
}

/**
 * Profile fields that describe what a fresh login reaches. An identity login covers every owned
 * account: no account_id is stored and the target is named per call (--account /
 * EASYPARCEL_ACCOUNT_ID / `ep account use`). The opposite marker is cleared (undefined) so a
 * re-login on the same profile stays consistent.
 */
export function loginTargetFields(accessToken?: string): { identity?: true; account_id?: number | string } {
  return isIdentityToken(accessToken)
    ? { identity: true, account_id: undefined }
    : { identity: undefined, account_id: accountIdFromToken(accessToken) };
}

/** `--profile <name>` for messages, empty for the default profile. */
function profileFlag(profile: string): string {
  return profile === DEFAULT_PROFILE ? "" : ` --profile ${profile}`;
}

/**
 * Who a stored session belongs to, from what is on this machine only (JWT claims, then the
 * stored index): a name or email when the token carries one, else the account label or a numeric
 * user id. Undefined when nothing readable is stored (opaque ids are never shown).
 */
export function signedInAs(creds: ProfileCredentials): string | undefined {
  if (creds.access_token?.startsWith("epat_")) return "a personal access token";
  const p = decodeJwtPayload(creds.access_token);
  const user = p?.user ?? {};
  const named = [user.name, user.email, p?.name, p?.email].find((v) => typeof v === "string" && v.trim());
  if (named) return String(named).trim();
  if (creds.account_label) return creds.account_label;
  if (/^\d+$/.test(String(user.id ?? ""))) return `user ${user.id}`;
  return undefined;
}

/** "Signed in as X" / "Signed in" when no readable name is stored. */
function signedInPhrase(creds: ProfileCredentials, prefix = "Signed in"): string {
  const who = signedInAs(creds);
  return who ? `${prefix} as ${who}` : prefix;
}

/** True when a stored session's access token is still usable without a refresh. */
function accessTokenFresh(creds: ProfileCredentials): boolean {
  return Boolean(creds.access_token) && !isExpired(creds.expires_at) && !isJwtExpired(creds.access_token);
}

/**
 * The profile's stored session when it is still good: a fresh access token, or a refresh token
 * that has not passed its stored expiry. No network call: a refresh token the server has revoked
 * shows up on the next API call, and `ep login --force` replaces it. Environment tokens are not a
 * stored session.
 */
export function existingSession(profile: string, nowMs = Date.now()): ProfileCredentials | undefined {
  if (hasEnvAccessToken() || process.env.EASYPARCEL_REFRESH_TOKEN) return undefined;
  if (!loadStore().profiles[profile]) return undefined;
  const creds = getProfileCredentials(profile);
  if (accessTokenFresh(creds)) return creds;
  if (creds.refresh_token) {
    const until = creds.refresh_token_expires_at ? Date.parse(creds.refresh_token_expires_at) : NaN;
    if (!Number.isFinite(until) || until > nowMs) return creds;
  }
  return undefined;
}

/**
 * Whether `ep login` should only report an existing session: plain `ep login` (also with
 * --non-interactive, so CI logins are idempotent), never for --force, --all, --with-token,
 * --client-credentials, or a --client-id / --scope other than the stored session's.
 */
export function shouldReportExistingSession(opts: Record<string, any>, stored: ProfileCredentials): boolean {
  if (opts.force || opts.all || opts.withToken || opts.clientCredentials) return false;
  if (opts.clientId !== undefined && opts.clientId !== stored.client_id) return false;
  if (opts.scope !== undefined && opts.scope !== (stored.scope ?? "")) return false;
  return true;
}

function persistLogin(ctx: RuntimeContext, tr: TokenResponse, client: ClientCreds, grant: string): void {
  const fields = loginTargetFields(tr.access_token);
  const identity = fields.identity === true;
  setProfileCredentials(
    ctx.profile,
    tokensFromResponse(tr, { client_id: client.clientId, client_secret: client.clientSecret, ...fields }),
  );
  log.info(`Authenticated profile '${ctx.profile}' via ${grant}.`);
  if (identity) log.info("This login covers all your accounts. Run `ep account list`, then pass --account <id> or `ep account use <id>`.");
  printJson({
    status: "ok",
    profile: ctx.profile,
    grant,
    target_mode: identity ? "identity" : "account",
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
  // An identity login already reaches every owned account (and the server refuses switch_token
  // for it), so one profile is all there is to save.
  if (isIdentityToken(baseTr.access_token)) {
    persistLogin(ctx, baseTr, client, grant);
    return;
  }
  // Persist the base token so apiRequest can authenticate the enumerate/switch calls.
  setProfileCredentials(
    ctx.profile,
    tokensFromResponse(baseTr, { client_id: client.clientId, client_secret: client.clientSecret }),
  );

  const listEnv = await apiRequest(ctx, { method: "GET", path: "account/list_accounts", target: false });
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
        target: false,
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
      tokensFromResponse(tr, { client_id: client.clientId, client_secret: client.clientSecret, account_label: String(acc.name), account_id: acc.account_id }),
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
  let accounts: number | null = null;
  if (opts.verify !== false) {
    try {
      // Verify THIS token: passing it explicitly also disables the 401 → refresh retry, which
      // would otherwise answer with the stored profile's refresh token and report a bad token as fine.
      // list_accounts needs no target, so it works for a personal access token on its own.
      const env = await apiRequest(ctx, { method: "GET", path: "account/list_accounts", accessToken: token, target: false });
      verified = (env.status_code ?? 0) < 400;
      if (verified && Array.isArray(env.data)) accounts = env.data.length;
    } catch {
      verified = false;
    }
  }
  if (accounts !== null) log.info(`This token can reach ${accounts} account(s). Run \`ep account list\`, then pass --account <id>.`);
  printJson({
    status: "ok",
    grant: "personal_access_token",
    profile: ctx.profile,
    persisted: false,
    token: masked,
    verified,
    accounts,
    note: "Token is NOT written to disk. Set EASYPARCEL_TOKEN (or EASYPARCEL_ACCESS_TOKEN) to reuse it.",
  });
}

async function deviceLogin(
  ctx: RuntimeContext,
  client: ClientCreds,
  o: { scope?: string; all: boolean; json: boolean; openBrowser?: boolean },
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
  // On a desktop, open the approval page ourselves (same opener as the browser flow); the code
  // stays printed for the cases where the page opens somewhere else or the browser is blocked.
  if (o.openBrowser && da.verification_uri_complete) {
    log.info("Opening your browser… if it does not open, use the URL above.");
    openUrl(da.verification_uri_complete);
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

  // Before anything else (no network, no browser), so the notice is the first thing shown.
  if (opts.all) warnDeprecatedMultiProfile();

  // --- --with-token: read an epat_ token from stdin (never persisted) ---
  if (opts.withToken) {
    await withTokenLogin(ctx, opts);
    return;
  }

  // Already signed in: say so instead of opening a browser and waiting. --force signs in again.
  const session = existingSession(ctx.profile);
  if (session && shouldReportExistingSession(opts, session)) {
    const flag = profileFlag(ctx.profile);
    log.info(
      `${signedInPhrase(session, "Already signed in")} (profile ${ctx.profile}). Use \`ep login --force${flag}\` to sign in again, or \`ep logout${flag}\`.`,
    );
    if (jsonMode || !process.stdout.isTTY) {
      printJson({
        status: "ok",
        already_signed_in: true,
        profile: ctx.profile,
        signed_in_as: signedInAs(session) ?? null,
        target_mode: session.identity || isIdentityToken(session.access_token) ? "identity" : "account",
        expires_at: session.expires_at ?? null,
      });
    }
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
    await deviceLogin(ctx, client, {
      scope,
      all: Boolean(opts.all),
      json: jsonMode,
      openBrowser: deviceOpensBrowser({ browserFlag: opts.browser, headless: detectHeadless(currentHeadlessSignals()) }),
    });
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

/** "token expires in 42 min" / "token expired …" from the stored expiry or the JWT `exp`. */
function expiryText(creds: ProfileCredentials, nowMs = Date.now()): string {
  const exp = decodeJwtPayload(creds.access_token)?.exp;
  const at = creds.expires_at ? Date.parse(creds.expires_at) : typeof exp === "number" ? exp * 1000 : NaN;
  if (!creds.access_token) return creds.refresh_token ? "access token renews on the next call" : "no access token";
  if (!Number.isFinite(at)) return "token expiry unknown";
  const mins = Math.round((at - nowMs) / 60000);
  if (mins <= 0) return creds.refresh_token ? "token expired (renews on the next call)" : "token expired";
  return mins >= 120 ? `token expires in ${Math.round(mins / 60)} h` : `token expires in ${mins} min`;
}

/** The human `ep auth status` line(s) for a terminal. Exported for tests. */
export function statusLine(
  profile: string,
  creds: ProfileCredentials,
  info: { storage: string; source: "env" | "store" | "none"; nowMs?: number },
): string {
  if (!creds.access_token && !creds.refresh_token) return `Not signed in (profile ${profile}). ${SIGNED_OUT_MESSAGE.replace(/^Not signed in\. /, "")}`;
  const identity = Boolean(creds.identity) || isIdentityToken(creds.access_token) || Boolean(creds.access_token?.startsWith("epat_"));
  const account = creds.account_id ?? accountIdFromToken(creds.access_token);
  const reach = identity ? "all accounts" : account !== undefined ? `account ${account}` : "one account";
  const parts = [
    `${signedInPhrase(creds)} — ${reach}`,
    `profile ${profile}`,
    expiryText(creds, info.nowMs),
    info.source === "env" ? "token from the environment" : `storage ${info.storage}`,
  ];
  if (creds.default_account_id !== undefined && creds.default_account_id !== null) parts.push(`default account ${creds.default_account_id}`);
  if (creds.default_organization_id) parts.push(`default organization ${creds.default_organization_id}`);
  return parts.join("; ");
}

function statusAction(): void {
  const ctx = getContext();
  const creds = getProfileCredentials(ctx.profile);
  const authenticated = Boolean(creds.access_token || creds.refresh_token);
  const identity =
    Boolean(creds.identity) || isIdentityToken(creds.access_token) || Boolean(creds.access_token?.startsWith("epat_"));
  const storage = loadStore().profiles[ctx.profile]?.storage ?? (keychainAvailable() ? "keychain" : "file");
  if (process.stdout.isTTY && !ctx.formatExplicit) {
    process.stdout.write(statusLine(ctx.profile, creds, { storage, source: tokenSource(ctx.profile) }) + "\n");
    const others = listProfiles().filter((p) => p !== ctx.profile);
    if (others.length) process.stdout.write(`Other profiles: ${others.join(", ")}  (details: ep auth status --format json)\n`);
    if (!authenticated) process.exitCode = ExitCode.AUTH;
    return;
  }
  printJson({
    profile: ctx.profile,
    base_url: ctx.baseUrl,
    api_version: ctx.apiVersion,
    authenticated,
    target_mode: identity ? "identity" : "account",
    account_id: identity ? null : (creds.account_id ?? accountIdFromToken(creds.access_token) ?? null),
    default_account_id: creds.default_account_id ?? null,
    default_organization_id: creds.default_organization_id ?? null,
    token_source: tokenSource(ctx.profile),
    has_access_token: Boolean(creds.access_token),
    has_refresh_token: Boolean(creds.refresh_token),
    expires_at: creds.expires_at ?? null,
    access_token_expired: creds.access_token ? isExpired(creds.expires_at) : null,
    // Where THIS profile's tokens live, not what the machine could do.
    storage,
    profiles: listProfiles(),
  });
  if (!authenticated) process.exitCode = ExitCode.AUTH;
}

async function refreshAction(): Promise<void> {
  const ctx = getContext();
  const creds = getProfileCredentials(ctx.profile);
  if (!creds.refresh_token) {
    throw new CliError(`No refresh token for this profile. ${SIGNED_OUT_MESSAGE.replace(/^Not signed in\. /, "")}`, ExitCode.AUTH);
  }
  const token = await doRefresh(ctx, creds);
  if (!token) throw new CliError(`Token refresh failed. ${SIGNED_OUT_MESSAGE.replace(/^Not signed in\. /, "")}`, ExitCode.AUTH);
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

/**
 * `ep auth sync`: with the session you already have, add a profile for every shipping account you
 * own that has none yet — no browser, no device approval. Uses the same list_accounts /
 * switch_token endpoints as `ep login --all`; the server only hands out tokens for owned accounts.
 */
async function syncAccountsAction(opts: Record<string, any>): Promise<void> {
  const ctx = getContext();
  warnDeprecatedMultiProfile();
  const creds = getProfileCredentials(ctx.profile);
  if (!creds.access_token && !creds.refresh_token) {
    throw new CliError(`Profile '${ctx.profile}' is not signed in. Run \`ep login\` or \`ep login --device\` first.`, ExitCode.AUTH);
  }
  if (creds.identity || isIdentityToken(creds.access_token)) {
    log.info(`Profile '${ctx.profile}' already covers all your accounts; nothing to sync. Run \`ep account list\`, then pass --account <id>.`);
    printJson({ status: "ok", target_mode: "identity", added: [], existing: [], stale: [], failed: [] });
    return;
  }
  const client = resolveClient(ctx, opts);
  const listEnv = await apiRequest(ctx, { method: "GET", path: "account/list_accounts", target: false });
  if ((listEnv.status_code ?? 0) >= 400 || !Array.isArray(listEnv.data)) {
    throw new CliError(`Could not list your accounts: ${listEnv.message || `HTTP ${listEnv.status_code}`}`, ExitCode.AUTH);
  }
  const accounts = listEnv.data as Array<{ account_id: number | string; name?: unknown; is_current?: boolean }>;
  // Full records (keychain included) so a profile saved before account_id was stored still counts.
  const store = loadStore();
  const profiles: Record<string, { account_id?: number | string; access_token?: string }> = {};
  for (const name of Object.keys(store.profiles)) profiles[name] = getProfileCredentials(name);
  const plan = planAccountSync(accounts, profiles);

  const used = new Set(Object.keys(store.profiles));
  const added: Array<{ account: unknown; account_id: number | string; profile: string }> = [];
  const failed: Array<{ account_id: number | string; reason: string }> = [];
  for (const acc of plan.add) {
    const env = await apiRequest(ctx, { method: "POST", path: "account/switch_token", body: { account_id: acc.account_id }, target: false });
    const data = env.data as any;
    if ((env.status_code ?? 0) >= 400 || !data || !data.access_token) {
      failed.push({ account_id: acc.account_id, reason: env.message || "could not mint token" });
      continue;
    }
    const slug = uniqueSlug(acc.name, acc.account_id, used);
    setProfileCredentials(
      slug,
      tokensFromResponse(data as TokenResponse, { client_id: client.clientId, client_secret: client.clientSecret, account_label: String(acc.name ?? ""), account_id: acc.account_id }),
    );
    added.push({ account: acc.name, account_id: acc.account_id, profile: slug });
  }
  for (const s of plan.stale) log.warn(`Profile '${s.profile}' is bound to account ${s.account_id}, which you no longer own; run \`ep logout --profile ${s.profile}\` to drop it.`);
  log.info(`${added.length} account(s) added, ${plan.existing.length} already had a profile, ${plan.stale.length} stale.`);
  printJson({ status: failed.length ? "partial" : "ok", added, existing: plan.existing, stale: plan.stale, failed });
  if (failed.length) process.exitCode = ExitCode.AUTH;
}

async function whoamiAction(): Promise<void> {
  const ctx = getContext();
  const env = await apiRequest(ctx, { method: "GET", path: "account/get_account_information" });
  printJson(ctx.dataOnly ? env.data : env);
  if ((env.status_code ?? 0) >= 400) process.exitCode = exitCodeForStatus(env.status_code ?? 0);
}

/** Attach the shared `login` options (used by both `ep login` and `ep auth login`). */
function attachLoginOptions(cmd: Command): Command {
  return cmd
    .option("--client-id <id>", "Override the built-in OAuth client id")
    .option("--client-secret <secret>", "OAuth client secret (only for confidential/custom apps)")
    .option("--device", "Sign in with a code you approve on any device (auto over SSH / headless). On a desktop it also opens the approval page; --no-browser prints the code only")
    .option("--no-device", "Force the browser flow even when headless")
    .option("--with-token", "Check a personal access token (epat_) read from stdin; never written to disk")
    .option("--no-verify", "Skip the server verification call for --with-token")
    .option("--client-credentials", "Use the client_credentials grant (no browser)")
    .option("--all", "Deprecated: one profile per account. Sign in once instead and pass --account <id> (see `ep account list`)")
    .option("--force", "Sign in again even when this profile already has a valid session")
    .option("--no-browser", "Never open a browser: browser flow → paste the redirect code back; --device → print the code only")
    .option("--redirect-uri <uri>", "Override the redirect URI (must be registered)")
    .option("--port <port>", `Loopback callback port (default ${DEFAULT_CALLBACK_PORT}, the only port registered for the built-in app; others need --redirect-uri)`)
    .option("--scope <scope>", "OAuth scope (usually empty for this API)")
    .option("--json", "Emit machine-readable JSON status (for agents/CI)")
    .option("--non-interactive", "Never prompt or wait for a person; fail instead (use with --with-token or --client-credentials)")
    .option("--wait <seconds>", "Seconds to wait for browser authorization", "300");
}

const LOGIN_DESCRIPTION =
  `Sign in to EasyParcel. By default your browser opens the EasyParcel sign-in page and the CLI receives the result ` +
  `on http://localhost:${DEFAULT_CALLBACK_PORT}/callback (OAuth2 + PKCE). --device: a short code you approve on any ` +
  "device (opens the approval page on a desktop; --no-browser prints the code only; auto-selected over SSH). " +
  "--with-token: check a personal access token piped on stdin (never stored). --non-interactive: fail instead of " +
  "waiting for a person. --force: sign in again when already signed in. --all: deprecated.";

const LOGIN_HELP = `
Flows:
  ep login                       Browser sign-in; the result comes back on localhost:${DEFAULT_CALLBACK_PORT}
  ep login --device              Code you approve on any device (opens the page on a desktop)
  ep login --device --no-browser Print the code only (SSH, servers, containers)
  printf %s "$TOKEN" | ep login --with-token   Check a personal access token (not stored)
  ep login --force               Sign in again although this profile is signed in

After signing in: ep account list, then --account <id> or ep account use <id>.
--all (one profile per account) is deprecated; use --account instead.`;

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Authenticate and manage credentials / profiles");

  addGlobalOptions(attachLoginOptions(auth.command("login").description(LOGIN_DESCRIPTION))).addHelpText("after", LOGIN_HELP).action(loginAction);

  addGlobalOptions(auth.command("status").description("Show authentication status for the active profile")).action(
    statusAction,
  );
  addGlobalOptions(auth.command("refresh").description("Force an access-token refresh")).action(refreshAction);
  addGlobalOptions(
    auth
      .command("sync")
      .description("Add a profile for each shipping account you own that has none yet, using the current session (no new approval)")
      .option("--client-id <id>", "Override the built-in OAuth client id")
      .option("--client-secret <secret>", "OAuth client secret (only for confidential/custom apps)"),
  ).action(syncAccountsAction);
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
  addGlobalOptions(attachLoginOptions(program.command("login").description(LOGIN_DESCRIPTION))).addHelpText("after", LOGIN_HELP).action(loginAction);
  addGlobalOptions(
    program
      .command("logout")
      .description("Revoke the refresh token server-side, then clear local credentials")
      .option("--client-id <id>", "OAuth client id for the revoke call")
      .option("--client-secret <secret>", "OAuth client secret for the revoke call")
      .option("--json", "Emit machine-readable JSON status"),
  ).action(logoutAction);
}
