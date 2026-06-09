// Typed errors and process exit codes.
//
// Exit codes are stable and documented so AI agents / scripts can branch on them.

export const ExitCode = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  AUTH: 3, // 401 / not authenticated
  NOT_FOUND: 4, // 404
  VALIDATION: 5, // 400
  RATE_LIMITED: 6, // 429
  ITEM_ERRORS: 7, // batch returned 200 but some items failed (with --fail-on-item-error)
  NETWORK: 8, // connection / timeout
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class CliError extends Error {
  exitCode: number;
  details?: unknown;
  constructor(message: string, exitCode: number = ExitCode.GENERIC, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}

/** Map an HTTP / envelope status code to a CLI exit code. */
export function exitCodeForStatus(status: number): number {
  switch (status) {
    case 200:
    case 201:
      return ExitCode.OK;
    case 400:
      return ExitCode.VALIDATION;
    case 401:
    case 403:
      return ExitCode.AUTH;
    case 404:
      return ExitCode.NOT_FOUND;
    case 429:
      return ExitCode.RATE_LIMITED;
    default:
      return status >= 400 ? ExitCode.GENERIC : ExitCode.OK;
  }
}
