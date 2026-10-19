import { shipmentOperations } from "./shipment";
import { courierOperations } from "./courier";
import { ondemandOperations } from "./ondemand";
import { accountOperations } from "./account";
import { organizationOperations } from "./organization";
import { einvoiceOperations } from "./einvoice";
import { addressOperations } from "./address";
import type { Operation, OperationGroup, Prerequisite } from "./types";

export * from "./types";

export const OPERATIONS: Operation[] = [
  ...shipmentOperations,
  ...courierOperations,
  ...ondemandOperations,
  ...accountOperations,
  ...organizationOperations,
  ...einvoiceOperations,
  ...addressOperations,
];

export const GROUPS: OperationGroup[] = ["shipment", "courier", "ondemand", "account", "organization", "einvoice", "address"];

export const GROUP_SUMMARY: Record<OperationGroup, string> = {
  shipment: "Standard shipping: quote, submit, track, cancel, insurance, parcel categories, AWB PDFs",
  courier: "Courier discovery: list couriers, drop-off points",
  ondemand: "On-demand / same-day delivery (Lalamove, PandaGo, …)",
  account: "Account profile, wallet balances, and the accounts this login can act on",
  organization: "Organizations you belong to",
  einvoice: "Malaysia e-Invoice (LHDN MyInvois)",
  address: "Saved address book (search your receiver addresses)",
};

export function operationsByGroup(group: OperationGroup): Operation[] {
  return OPERATIONS.filter((o) => o.group === group);
}

export function getOperation(id: string): Operation | undefined {
  return OPERATIONS.find((o) => o.id === id || `${o.group}.${o.command}` === id || o.command === id);
}

/** MCP tool name for an operation, e.g. ep_shipment_quote. */
export function mcpToolName(op: Operation): string {
  return `ep_${op.group}_${op.command}`.replace(/-/g, "_");
}

/** The CLI command for an operation id, e.g. "shipment.quote" → "ep shipment quote". */
export function cliCommand(opId: string): string {
  const op = getOperation(opId);
  return op ? `ep ${op.group === "organization" ? "org" : op.group} ${op.command}` : opId;
}

/** The target an operation acts on, or undefined for target-free listings. */
export function targetScope(op: Operation): "account" | "organization" | undefined {
  if (op.target === false) return undefined;
  return op.scope ?? "account";
}

/** Target edge every account-scoped operation shares (identity logins name the account per call). */
const ACCOUNT_EDGE: Prerequisite = {
  param: "account_id",
  from: "account.list",
  field: "[].account_id",
  when: "the login covers all your accounts",
  note: "Pass it as --account <id> (MCP: account_id).",
};

const ORGANIZATION_EDGE: Prerequisite = {
  param: "organization_id",
  from: "organization.list",
  field: "[].organization_id",
  when: "no default organization is set",
  note: "Pass it as --organization <id|ref> (MCP: organization_id).",
};

/** Every prerequisite edge of an operation: its own, then the target edge its scope implies. */
export function prerequisitesOf(op: Operation): Prerequisite[] {
  const own = op.prerequisites ?? [];
  const scope = targetScope(op);
  if (scope === "account") return [...own, ACCOUNT_EDGE];
  if (scope === "organization") return [...own, ORGANIZATION_EDGE];
  return own;
}

/** The leaf name of a param path, e.g. "shipment[].service_id" → "service_id". */
export function paramLeaf(param: string): string {
  const parts = param.replace(/\[\]/g, "").split(".").filter(Boolean);
  return parts[parts.length - 1] ?? param;
}

/** One help line per edge: `shipment[].service_id  ← ep shipment quote  (field)  when …`. */
export function prerequisiteLines(op: Operation): string[] {
  const edges = prerequisitesOf(op);
  if (!edges.length) return [];
  const width = Math.min(28, Math.max(...edges.map((e) => e.param.length)));
  return edges.map((e) => {
    let line = `${e.param.padEnd(width)}  ← ${cliCommand(e.from)}`;
    if (e.field) line += `  (${e.field})`;
    if (e.when) line += `  when ${e.when}`;
    if (e.note) line += `. ${e.note}`;
    return line;
  });
}

/** The prerequisite sentence appended to an MCP tool description. */
export function mcpPrerequisiteText(op: Operation): string | undefined {
  const edges = prerequisitesOf(op);
  if (!edges.length) return undefined;
  const parts = edges.map((e) => {
    const from = getOperation(e.from);
    let t = `${e.param} from ${from ? mcpToolName(from) : e.from}`;
    if (e.field) t += ` (${e.field})`;
    if (e.when) t += ` when ${e.when}`;
    return t;
  });
  return `Prerequisites: ${parts.join("; ")}.`;
}
