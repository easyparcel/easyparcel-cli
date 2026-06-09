import { sleep } from "./http";
import { log } from "./logger";
import type { RuntimeContext } from "./context";
import type { Envelope } from "./types";

export interface PaginateSpec {
  /** Fetch one page given an optional cursor. */
  fetch: (cursor: string | undefined) => Promise<Envelope>;
  /** Extract the cursor for the NEXT (older) page; undefined = stop. */
  nextCursor: (env: Envelope) => string | undefined;
}

/**
 * Walk a cursor-paginated list endpoint, concatenating `data` arrays across
 * pages. Bounded by ctx.page.limit (max pages) and spaced by ctx.page.delayMs.
 */
export async function paginateAll(ctx: RuntimeContext, spec: PaginateSpec): Promise<Envelope> {
  const maxPages = ctx.page.limit && ctx.page.limit > 0 ? ctx.page.limit : Number.POSITIVE_INFINITY;
  let cursor: string | undefined;
  let pages = 0;
  let merged: unknown[] = [];
  let last: Envelope | undefined;

  while (pages < maxPages) {
    const env = await spec.fetch(cursor);
    last = env;
    if (Array.isArray(env.data)) merged = merged.concat(env.data);
    pages++;
    const next = spec.nextCursor(env);
    if (!next) break;
    cursor = next;
    log.debug(`paginated ${pages} page(s); next cursor=${cursor}`);
    if (ctx.page.delayMs) await sleep(ctx.page.delayMs);
  }

  const base = last ?? ({ status_code: 200, data: [] } as Envelope);
  const result: Envelope = { ...base, data: merged };
  result.pagination = { pages, returned: merged.length };
  return result;
}
