import { shipmentOperations } from "./shipment";
import { courierOperations } from "./courier";
import { ondemandOperations } from "./ondemand";
import { accountOperations } from "./account";
import { organizationOperations } from "./organization";
import { einvoiceOperations } from "./einvoice";
import { addressOperations } from "./address";
import type { Operation, OperationGroup } from "./types";

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
  shipment: "Standard shipping: quote, submit, track, cancel, insurance",
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
