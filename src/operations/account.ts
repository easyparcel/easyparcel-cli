import { type Operation } from "./types";

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
];
