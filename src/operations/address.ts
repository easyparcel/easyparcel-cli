import { type Operation, str, num, obj } from "./types";

export const addressOperations: Operation[] = [
  {
    id: "address.search",
    group: "address",
    command: "search",
    topLevelAlias: "address-book",
    summary: "Search your saved receiver address book",
    description:
      "Searches the authenticated account's saved receiver addresses. With no keyword it lists the most recent entries. Matches name / company / email / phone / address / city / postcode.",
    method: "GET",
    path: "address/search",
    body: "json",
    bodyRequired: false,
    docNote: "GET-with-body: pass { search, limit } via --data, or omit to list recent.",
    schema: obj({
      search: str("Keyword: name, phone, company, city, postcode, …"),
      limit: num("Max results (default 20, max 100)"),
    }),
    example: { search: "john", limit: 20 },
    examples: [`ep address search --data '{"search":"john"}'`, `ep +address john`],
  },
];
