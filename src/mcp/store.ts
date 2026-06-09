import { log } from "../core/logger";

/**
 * Persistence for the OAuth proxy's transient state (registered clients, pending
 * authorizations, one-time codes). The proxy was originally backed by in-memory Maps,
 * which are lost on every pod restart/rollout and can't be shared across replicas — so a
 * client that registered against an old pod hits `invalid_client` after a deploy. A shared
 * store (Redis) fixes both: registrations survive rollouts and replicas can scale out.
 *
 * Records carry their own TTL (clients ~30d, pending/codes ~10min); the store enforces it.
 */
export interface OAuthStore {
  get<T>(kind: StoreKind, key: string): Promise<T | undefined>;
  /** Store a JSON-serialisable record under `key`, expiring after `ttlMs`. */
  set<T>(kind: StoreKind, key: string, value: T, ttlMs: number): Promise<void>;
  del(kind: StoreKind, key: string): Promise<void>;
  /** Number of live records of a kind (best-effort; used only for the registration cap). */
  count(kind: StoreKind): Promise<number>;
  close(): Promise<void>;
}

export type StoreKind = "client" | "pending" | "code";

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** Default in-memory store — single instance, lost on restart. Keeps the CLI dependency-free. */
export class InMemoryStore implements OAuthStore {
  private maps: Record<StoreKind, Map<string, Entry>> = {
    client: new Map(),
    pending: new Map(),
    code: new Map(),
  };

  private sweep(kind: StoreKind): void {
    const now = Date.now();
    for (const [k, v] of this.maps[kind]) if (v.expiresAt <= now) this.maps[kind].delete(k);
  }

  async get<T>(kind: StoreKind, key: string): Promise<T | undefined> {
    const e = this.maps[kind].get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      this.maps[kind].delete(key);
      return undefined;
    }
    return e.value as T;
  }

  async set<T>(kind: StoreKind, key: string, value: T, ttlMs: number): Promise<void> {
    this.maps[kind].set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async del(kind: StoreKind, key: string): Promise<void> {
    this.maps[kind].delete(key);
  }

  async count(kind: StoreKind): Promise<number> {
    this.sweep(kind);
    return this.maps[kind].size;
  }

  async close(): Promise<void> {
    /* nothing to close */
  }
}

/**
 * Redis-backed store. `ioredis` is loaded lazily (an optional dependency) so plain CLI
 * users never pull it — only the hosted MCP server, which sets EP_MCP_REDIS_URL, does.
 * Keys are namespaced (`epmcp:<ns>:<kind>:<key>`) so multiple deployments (ChatGPT / Claude
 * / general) can share one Redis without colliding; TTL is delegated to Redis (`PX`).
 */
export class RedisStore implements OAuthStore {
  private constructor(
    private readonly redis: import("ioredis").Redis,
    private readonly ns: string,
  ) {}

  static async connect(url: string, namespace: string): Promise<RedisStore> {
    let IoRedis: typeof import("ioredis").Redis;
    try {
      ({ Redis: IoRedis } = await import("ioredis"));
    } catch {
      throw new Error(
        "EP_MCP_REDIS_URL is set but the 'ioredis' package is not installed. " +
          "Add it (npm i ioredis) or unset EP_MCP_REDIS_URL to use the in-memory store.",
      );
    }
    const redis = new IoRedis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    redis.on("error", (e: Error) => log.error(`OAuth Redis store error: ${e.message}`));
    await redis.connect();
    return new RedisStore(redis, namespace);
  }

  private k(kind: StoreKind, key: string): string {
    return `epmcp:${this.ns}:${kind}:${key}`;
  }

  async get<T>(kind: StoreKind, key: string): Promise<T | undefined> {
    const raw = await this.redis.get(this.k(kind, key));
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set<T>(kind: StoreKind, key: string, value: T, ttlMs: number): Promise<void> {
    await this.redis.set(this.k(kind, key), JSON.stringify(value), "PX", ttlMs);
  }

  async del(kind: StoreKind, key: string): Promise<void> {
    await this.redis.del(this.k(kind, key));
  }

  async count(kind: StoreKind): Promise<number> {
    // Best-effort; only used to cap unauthenticated /register growth. SCAN avoids blocking.
    let cursor = "0";
    let total = 0;
    const match = `epmcp:${this.ns}:${kind}:*`;
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", match, "COUNT", 500);
      cursor = next;
      total += keys.length;
    } while (cursor !== "0");
    return total;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// Pre-registered clients are re-seeded on every boot and kept for a year, so a known MCP
// connector (e.g. an already-installed ChatGPT app that registered against an older, since-
// replaced pod) keeps working without the user having to remove + re-add it.
const SEED_CLIENT_TTL = 365 * 24 * 60 * 60 * 1000;

/**
 * Seed pre-registered OAuth clients from EP_MCP_SEED_CLIENTS — a JSON array of
 * `{ "client_id": "...", "redirect_uris": ["https://..."], "client_name"?: "..." }`. The
 * redirect_uris MUST match exactly what the client sends to /authorize (incl. path), or the
 * authorization is rejected as redirect_uri-not-registered. Invalid entries are skipped, never fatal.
 */
export async function seedOAuthClients(store: OAuthStore, json?: string): Promise<number> {
  if (!json) return 0;
  let seeds: unknown;
  try {
    seeds = JSON.parse(json);
  } catch {
    log.warn("EP_MCP_SEED_CLIENTS is not valid JSON — ignoring.");
    return 0;
  }
  if (!Array.isArray(seeds)) {
    log.warn("EP_MCP_SEED_CLIENTS must be a JSON array — ignoring.");
    return 0;
  }
  let n = 0;
  for (const s of seeds as Array<Record<string, unknown>>) {
    const clientId = typeof s?.client_id === "string" ? s.client_id : "";
    const redirectUris = Array.isArray(s?.redirect_uris) ? (s.redirect_uris as string[]) : [];
    if (!clientId || redirectUris.length === 0) {
      log.warn("EP_MCP_SEED_CLIENTS entry missing client_id/redirect_uris — skipped.");
      continue;
    }
    await store.set(
      "client",
      clientId,
      { redirectUris, name: typeof s.client_name === "string" ? s.client_name : "seeded", createdAt: Date.now() },
      SEED_CLIENT_TTL,
    );
    n++;
  }
  if (n) log.info(`Seeded ${n} pre-registered OAuth client(s).`);
  return n;
}

/**
 * Build the store for the OAuth proxy. With EP_MCP_REDIS_URL (or REDIS_URL) set, uses Redis
 * (durable across rollouts, safe for multiple replicas); otherwise the in-memory default.
 */
export async function createOAuthStore(opts: {
  redisUrl?: string;
  namespace: string;
}): Promise<{ store: OAuthStore; durable: boolean }> {
  if (opts.redisUrl) {
    const store = await RedisStore.connect(opts.redisUrl, opts.namespace);
    log.info(`OAuth proxy state store: Redis (namespace "${opts.namespace}").`);
    return { store, durable: true };
  }
  return { store: new InMemoryStore(), durable: false };
}
