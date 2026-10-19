import { type Operation, yesNo } from "./types";

/** Rows for `ep account list` on a terminal (fields per the list_accounts contract; missing ones stay blank). */
export function accountRows(data: unknown): Record<string, unknown>[] {
  const list = Array.isArray(data) ? data : [];
  return list.map((a: any) => ({
    ACCOUNT_ID: a?.account_id ?? "",
    NAME: a?.name ?? "",
    TYPE: a?.account_type ?? "",
    COUNTRY: a?.base_country ?? "",
    ORGANISATION: a?.organization_id ?? "",
    TOKEN_USABLE: yesNo(a?.token_usable),
  }));
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
      columns: ["ACCOUNT_ID", "NAME", "TYPE", "COUNTRY", "ORGANISATION", "TOKEN_USABLE"],
      rows: accountRows,
    },
  },
];
