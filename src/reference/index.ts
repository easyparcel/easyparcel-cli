// Reference data for validation, help and AI-agent context.

export interface MyState {
  /** ISO 3166-2 code used across most endpoints (subdivision_code / state_code). */
  iso: string;
  /** 2-digit numeric code used ONLY by the Malaysia e-Invoice endpoints. */
  einvoice: string;
  name: string;
}

export const MY_STATES: MyState[] = [
  { iso: "MY-01", einvoice: "01", name: "Johor" },
  { iso: "MY-02", einvoice: "02", name: "Kedah" },
  { iso: "MY-03", einvoice: "03", name: "Kelantan" },
  { iso: "MY-04", einvoice: "04", name: "Melaka" },
  { iso: "MY-05", einvoice: "05", name: "Negeri Sembilan" },
  { iso: "MY-06", einvoice: "06", name: "Pahang" },
  { iso: "MY-07", einvoice: "07", name: "Pulau Pinang (Penang)" },
  { iso: "MY-08", einvoice: "08", name: "Perak" },
  { iso: "MY-09", einvoice: "09", name: "Perlis" },
  { iso: "MY-10", einvoice: "10", name: "Selangor" },
  { iso: "MY-11", einvoice: "11", name: "Terengganu" },
  { iso: "MY-12", einvoice: "12", name: "Sabah" },
  { iso: "MY-13", einvoice: "13", name: "Sarawak" },
  { iso: "MY-14", einvoice: "14", name: "Kuala Lumpur" },
  { iso: "MY-15", einvoice: "15", name: "Labuan" },
  { iso: "MY-16", einvoice: "16", name: "Putrajaya" },
];

/** Couriers are documented as available only for these countries. */
export const SUPPORTED_COURIER_COUNTRIES = ["MY", "SG"];

/** Tracking status codes (from the Tracking endpoint). */
export const TRACKING_STATUS: Record<number, string> = {
  1: "Order Created",
  2: "Payment Confirmed",
  3: "Ready for Collection",
  4: "Item Collected",
  5: "In Transit to Hub",
  6: "Processing at Hub",
  7: "Schedule In Arrangement",
  8: "Out for Delivery",
  9: "Delivered",
  10: "Delivery Failed",
  11: "Return to Sender",
};

/** Webhook status codes — DIFFERENT set from TRACKING_STATUS; do not assume parity. */
export const WEBHOOK_STATUS: Record<number, string> = {
  0: "Cancel",
  2: "To Be Collected",
  3: "Collected",
  4: "Delivery In Transit",
  5: "Delivered",
  6: "Returned",
  7: "Schedule In Arrangement",
  8: "On Hold",
  11: "Drop Off",
};

/** Webhook topic strings configured in the Developer Hub. */
export const WEBHOOK_TOPICS: Record<number, string> = {
  1: "shipment.status.update",
  2: "shipment.awb.update",
  3: "shipment.tracking.update",
  4: "shipment.created",
  5: "ondemand.status.update",
};

/** Observed ID prefixes across the API. */
export const ID_PREFIXES: Record<string, string> = {
  order: "EI-YYMM-XXXXX",
  shipment: "ES-YYMM-XXXXX",
  ondemand_booking: "EOD-### (also ED-### in listings)",
  courier: "EP-CR…",
  service: "EP-CS…",
  insurance_service: "EP-IR…",
  dropoff_point: "EP-CB…",
  einvoice_submission: "EP-MEI…",
};

export function isIso2(code: string): boolean {
  return /^[A-Za-z]{2}$/.test(code);
}

/**
 * Resolve a Malaysian state from a name, ISO code (MY-07 / 07 / 7) and return
 * both code systems. Useful because e-Invoice uses a different code scheme.
 */
export function resolveMyState(input: string): MyState | undefined {
  const v = input.trim();
  const lower = v.toLowerCase();
  return MY_STATES.find(
    (s) =>
      s.iso.toLowerCase() === lower ||
      s.einvoice === v ||
      String(Number(s.einvoice)) === v ||
      s.name.toLowerCase() === lower ||
      s.name.toLowerCase().includes(lower),
  );
}
