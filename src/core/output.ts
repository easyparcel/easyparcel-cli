import type { RuntimeContext } from "./context";
import type { Envelope } from "./types";

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

export interface Colorizer {
  dim: (s: string) => string;
  bold: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  cyan: (s: string) => string;
  gray: (s: string) => string;
}

export function makeColor(enabled: boolean): Colorizer {
  const wrap =
    (code: string) =>
    (s: string): string =>
      enabled ? `[${code}m${s}[0m` : s;
  return {
    dim: wrap("2"),
    bold: wrap("1"),
    red: wrap("31"),
    green: wrap("32"),
    yellow: wrap("33"),
    cyan: wrap("36"),
    gray: wrap("90"),
  };
}

// ---------------------------------------------------------------------------
// Table / CSV rendering
// ---------------------------------------------------------------------------

function toRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.map((d) => (d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : { value: d }));
  }
  if (data && typeof data === "object") return [data as Record<string, unknown>];
  return [{ value: data }];
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return Array.isArray(v) ? `[${v.length}]` : "{…}";
  return String(v);
}

function inferColumns(rows: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      const v = r[k];
      if (v && typeof v === "object") continue; // skip nested objects/arrays in auto columns
      if (!keys.includes(k)) keys.push(k);
    }
  }
  // If every value was nested, fall back to all keys.
  if (keys.length === 0) for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  return keys;
}

const MAX_CELL = 48;

function clip(s: string): string {
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > MAX_CELL ? oneLine.slice(0, MAX_CELL - 1) + "…" : oneLine;
}

export function renderTable(rows: Record<string, unknown>[], columns: string[] | undefined, color: Colorizer): string {
  if (rows.length === 0) return color.gray("(no rows)");
  const cols = columns && columns.length ? columns : inferColumns(rows);
  const widths = cols.map((c) => c.length);
  const cells = rows.map((r) =>
    cols.map((c, i) => {
      const s = clip(scalar(r[c]));
      if (s.length > widths[i]) widths[i] = s.length;
      return s;
    }),
  );
  // Pad first, THEN color, so ANSI codes never count toward column width.
  const header = cols.map((c, i) => " " + color.bold(c.padEnd(widths[i])) + " ").join("|");
  const separator = widths.map((w) => "-".repeat(w + 2)).join("+");
  const body = cells.map((row) => row.map((v, i) => " " + v.padEnd(widths[i]) + " ").join("|"));
  return [header, separator, ...body].join("\n");
}

function csvCell(v: unknown): string {
  const s = scalar(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return "";
  const cols = columns && columns.length ? columns : inferColumns(rows);
  const lines = [cols.map(csvCell).join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Top-level result printer
// ---------------------------------------------------------------------------

export interface PrintOptions {
  /** Preferred columns for table/csv output. */
  columns?: string[];
}

/** Print a result envelope to STDOUT in the configured format. */
export function printEnvelope(env: Envelope, ctx: RuntimeContext, opts: PrintOptions = {}): void {
  const payload = ctx.dataOnly ? env.data : env;
  switch (ctx.format) {
    case "ndjson": {
      const rows = Array.isArray(env.data) ? env.data : [env.data];
      for (const r of rows) process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    case "table": {
      process.stdout.write(renderTable(toRows(env.data), opts.columns, makeColor(ctx.color)) + "\n");
      return;
    }
    case "csv": {
      process.stdout.write(renderCsv(toRows(env.data), opts.columns) + "\n");
      return;
    }
    case "json":
    case "pretty":
    default:
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
      return;
  }
}

/** Print an arbitrary JSON value (used by non-API commands like auth status). */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
