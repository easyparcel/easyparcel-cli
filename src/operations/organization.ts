import { type Operation, yesNo } from "./types";

/** Rows for `ep org list` on a terminal (fields per the organization/list contract; missing ones stay blank). */
export function organizationRows(data: unknown): Record<string, unknown>[] {
  const list = Array.isArray(data) ? data : [];
  return list.map((o: any) => ({
    ORG_ID: o?.organization_id ?? o?.id ?? "",
    REF: o?.ref ?? "",
    NAME: o?.name ?? "",
    ROLE: o?.role ?? "",
    WHATSAPP: yesNo(o?.products?.whatsapp),
    AI_AGENT: yesNo(o?.products?.ai_agent),
  }));
}

export const organizationOperations: Operation[] = [
  {
    id: "organization.list",
    group: "organization",
    command: "list",
    summary: "List the organizations you belong to",
    description:
      "Organizations where you are an active member, with your role and the products they hold (WhatsApp, AI agent). " +
      "Name one per call with --organization <id|ref> (MCP: organization_id), or store a default with `ep org use <id|ref>`.",
    method: "GET",
    path: "organization/list",
    body: "none",
    target: false,
    examples: ["ep org list", "ep org use ABCDEF"],
    provides: ["[].organization_id"],
    humanTable: {
      columns: ["ORG_ID", "REF", "NAME", "ROLE", "WHATSAPP", "AI_AGENT"],
      rows: organizationRows,
    },
  },
];
