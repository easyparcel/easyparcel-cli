// Diagnostics logger. Everything here writes to STDERR so that STDOUT stays
// clean for machine-readable results (critical for piping and AI-agent parsing).

export type LogLevel = "silent" | "normal" | "verbose";

let level: LogLevel = "normal";

export function setLogLevel(l: LogLevel): void {
  level = l;
}

export function getLogLevel(): LogLevel {
  return level;
}

function write(line: string): void {
  process.stderr.write(line + "\n");
}

export const log = {
  /** Informational progress message (stderr). */
  info(msg: string): void {
    if (level !== "silent") write(msg);
  },
  /** Warning (stderr). */
  warn(msg: string): void {
    if (level !== "silent") write("warning: " + msg);
  },
  /** Error (stderr) — always shown. */
  error(msg: string): void {
    write("error: " + msg);
  },
  /** Verbose debug detail (stderr, only with --verbose). */
  debug(msg: string): void {
    if (level === "verbose") write("debug: " + msg);
  },
};
