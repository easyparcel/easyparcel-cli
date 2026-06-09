import fs from "node:fs";
import { CliError, ExitCode } from "../core/errors";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

/**
 * Resolve a --data value. Accepts:
 *   - a raw JSON string:  --data '{"a":1}'
 *   - a file reference:   --data @order.json
 *   - stdin:              --data -
 */
export async function resolveData(data: string | undefined): Promise<unknown | undefined> {
  if (data === undefined) return undefined;
  let raw = data;
  if (data === "-") {
    raw = await readStdin();
  } else if (data.startsWith("@")) {
    const file = data.slice(1);
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      throw new CliError(`Could not read --data file: ${file}`, ExitCode.USAGE);
    }
  }
  raw = raw.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CliError(`--data is not valid JSON: ${(e as Error).message}`, ExitCode.USAGE);
  }
}
