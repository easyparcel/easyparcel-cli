import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface RawRequestOptions {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * Low-level HTTP(S) request built on node:http.
 *
 * We deliberately do NOT use global fetch(): the EasyParcel API has several
 * endpoints that are documented as GET but require a JSON request body
 * (e.g. courier/list, shipment/get_coupon_list). The Fetch standard forbids a
 * body on GET, and Node's fetch throws. node:http has no such restriction, so
 * this gives us full control over method+body combinations, timeouts and retries.
 */
export function rawRequest(urlStr: string, opts: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`invalid URL: ${urlStr}`));
      return;
    }
    const lib = url.protocol === "http:" ? http : https;
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body != null && headers["Content-Length"] == null) {
      headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    }

    const req = lib.request(url, { method: opts.method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);
    const timeoutMs = opts.timeoutMs ?? 60000;
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });

    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
