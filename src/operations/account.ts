import type { HumanTableContext, Operation } from "./types";

/** Wallet currency per base country (the API derives it the same way); blank when unknown. */
const COUNTRY_CURRENCY: Record<string, string> = { MY: "MYR", SG: "SGD" };

/** Rows for `ep account list` on a terminal (fields per the list_accounts contract; missing ones stay blank). */
export function accountRows(data: unknown, ctx: HumanTableContext = {}): Record<string, unknown>[] {
  const list = Array.isArray(data) ? data : [];
  return list.map((a: any) => {
    const country = a?.base_country ?? "";
    return {
      ACCOUNT_ID: a?.account_id ?? "",
      NAME: a?.name ?? "",
      TYPE: a?.account_type ?? "",
      COUNTRY: country,
      CURRENCY: a?.currency ?? COUNTRY_CURRENCY[String(country).toUpperCase()] ?? "",
      DEFAULT: ctx.defaultAccountId !== undefined && String(a?.account_id) === String(ctx.defaultAccountId) ? "*" : "",
    };
  });
}

/** Rows for `ep wallet --format table`: one row per balance (credit wallet, then free credit). */
export function walletRows(data: unknown): Record<string, unknown>[] {
  const d = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const rows: Record<string, unknown>[] = [];
  const add = (kind: string, list: unknown) => {
    for (const w of Array.isArray(list) ? list : []) rows.push({ WALLET: kind, BALANCE: (w as any)?.balance ?? "", CURRENCY: (w as any)?.currency ?? "" });
  };
  add("credit", d.wallet);
  add("free credit", d.free_credit_wallet);
  return rows;
}

export const accountOperations: Operation[] = [
  {
    id: "account.info",
    group: "account",
    command: "info",
    summary: "Get account profile and default pickup/billing/delivery addresses",
    method: "GET",
    path: "account/get_account_information",
    body: "none",
    example: undefined,
  },
  {
    id: "account.wallet",
    group: "account",
    command: "wallet",
    topLevelAlias: "wallet",
    summary: "Get credit wallet and free-credit balances",
    method: "GET",
    path: "wallet",
    body: "none",
    humanTable: { columns: ["WALLET", "BALANCE", "CURRENCY"], rows: walletRows },
  },
  {
    id: "account.list",
    group: "account",
    command: "list",
    summary: "List the shipping accounts this login can act on",
    description:
      "Shipping accounts this login reaches (owner seats for an all-accounts login or a personal access token). " +
      "Name one per call with --account <id> (MCP: account_id), or store a default with `ep account use <id>`.",
    method: "GET",
    path: "account/list_accounts",
    body: "none",
    target: false,
    examples: ["ep account list", "ep account use 123456", "ep wallet --account 123456"],
    provides: ["[].account_id"],
    humanTable: {
      columns: ["ACCOUNT_ID", "NAME", "TYPE", "COUNTRY", "CURRENCY", "DEFAULT"],
      rows: accountRows,
    },
  },
];
