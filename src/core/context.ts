import { loadConfig, DEFAULT_BASE_URL, DEFAULT_API_VERSION, DEFAULT_PROFILE } from "./config";
import { setLogLevel } from "./logger";
import type { EpConfig, Format } from "./types";

/** Global flags shared by all commands (parsed by commander on the root program). */
export interface GlobalOptions {
  profile?: string;
  baseUrl?: string;
  apiVersion?: string;
  format?: string;
  dryRun?: boolean;
  color?: boolean; // commander sets this to false for --no-color
  quiet?: boolean;
  verbose?: boolean;
  dataOnly?: boolean;
  failOnItemError?: boolean;
  timeout?: string | number; // seconds
  retries?: string | number;
  pageAll?: boolean;
  pageLimit?: string | number;
  pageDelay?: string | number; // ms
}

export interface RuntimeContext {
  config: EpConfig;
  baseUrl: string;
  apiVersion: string;
  profile: string;
  format: Format;
  /** True when --format/-f was explicitly provided (shortcuts use this to default to table). */
  formatExplicit: boolean;
  dryRun: boolean;
  color: boolean;
  quiet: boolean;
  verbose: boolean;
  dataOnly: boolean;
  failOnItemError: boolean;
  timeoutMs: number;
  retries: number;
  page: { all: boolean; limit?: number; delayMs: number };
}

let current: RuntimeContext | null = null;

export function getContext(): RuntimeContext {
  if (!current) throw new Error("runtime context not initialized");
  return current;
}

export function setContext(ctx: RuntimeContext): void {
  current = ctx;
}

const VALID_FORMATS: Format[] = ["json", "pretty", "table", "ndjson", "csv"];

function num(v: string | number | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function envColorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

export function buildContext(opts: GlobalOptions): RuntimeContext {
  const config = loadConfig();
  const baseUrl = opts.baseUrl || process.env.EASYPARCEL_BASE_URL || config.base_url || DEFAULT_BASE_URL;
  const apiVersion =
    opts.apiVersion || process.env.EASYPARCEL_API_VERSION || config.api_version || DEFAULT_API_VERSION;
  const profile = opts.profile || process.env.EASYPARCEL_PROFILE || config.default_profile || DEFAULT_PROFILE;

  const verbose = Boolean(opts.verbose);
  const quiet = Boolean(opts.quiet);
  setLogLevel(quiet ? "silent" : verbose ? "verbose" : "normal");

  const format = (opts.format && VALID_FORMATS.includes(opts.format as Format)
    ? (opts.format as Format)
    : "json") as Format;

  const ctx: RuntimeContext = {
    config,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiVersion,
    profile,
    format,
    formatExplicit: Boolean(opts.format),
    dryRun: Boolean(opts.dryRun),
    color: opts.color === false ? false : envColorEnabled(),
    quiet,
    verbose,
    dataOnly: Boolean(opts.dataOnly),
    failOnItemError: Boolean(opts.failOnItemError),
    timeoutMs: (num(opts.timeout) ?? 60) * 1000,
    retries: num(opts.retries) ?? 2,
    page: {
      all: Boolean(opts.pageAll),
      limit: num(opts.pageLimit),
      delayMs: num(opts.pageDelay) ?? 0,
    },
  };
  setContext(ctx);
  return ctx;
}
