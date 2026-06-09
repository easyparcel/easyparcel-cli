import { type Operation, str, num, bool, arr, obj, addressSchema } from "./types";
import type { Envelope } from "../core/types";

function paginationCursor(field: "next_shipment_number" | "next_booking_number") {
  return (env: Envelope): string | undefined => {
    const p = (env.pagination ?? (env.data as any)?.pagination) as any;
    if (p && typeof p === "object" && p.has_more) {
      const c = p[field] ?? p.next_page_token;
      if (c) return String(c);
    }
    return undefined;
  };
}

const itemSchema = obj(
  {
    content: str("Item description"),
    weight: num("kg"),
    height: num("cm"),
    length: num("cm"),
    width: num("cm"),
    currency_code: str('e.g. "MYR"'),
    value: num("Declared value"),
    quantity: num("Integer quantity"),
  },
  ["content", "weight", "currency_code", "value", "quantity"],
);

export const shipmentOperations: Operation[] = [
  {
    id: "shipment.quote",
    group: "shipment",
    command: "quote",
    aliases: ["rates", "quotations"],
    topLevelAlias: "quote",
    summary: "Get live shipping rates from all couriers for a parcel",
    description:
      "Returns available courier services, pricing and features (COD, tracking, insurance, DDP) for one or more sender/receiver/parcel scenarios.",
    method: "POST",
    path: "shipment/quotations",
    body: "json",
    bodyRequired: true,
    schema: obj(
      {
        shipment: arr(
          obj(
            {
              sender: obj(
                { postcode: str(), subdivision_code: str("ISO 3166-2"), country: str("ISO alpha-2") },
                ["postcode", "country"],
              ),
              receiver: obj(
                { postcode: str(), subdivision_code: str("ISO 3166-2"), country: str("ISO alpha-2") },
                ["postcode", "country"],
              ),
              weight: num("kg"),
              width: num("cm"),
              height: num("cm"),
              length: num("cm"),
              parcel_value: num("Declared value (for insurance/DDP)"),
              parcel_category_id: num("From `ep ... parcel-category list` (DDP)"),
            },
            ["sender", "receiver", "weight"],
          ),
          "One entry per parcel scenario to quote (batch).",
        ),
      },
      ["shipment"],
    ),
    example: {
      shipment: [
        {
          sender: { postcode: "11950", subdivision_code: "MY-07", country: "MY" },
          receiver: { postcode: "520111", subdivision_code: "", country: "SG" },
          weight: 2.5,
        },
      ],
    },
    examples: [
      `ep quote --data '{"shipment":[{"sender":{"postcode":"11950","country":"MY"},"receiver":{"postcode":"55100","country":"MY"},"weight":1}]}'`,
      `ep +rates --from 11950 --to 55100 --weight 1   # shortcut`,
    ],
  },

  {
    id: "shipment.coupon-list",
    group: "shipment",
    command: "coupon-list",
    summary: "List coupons applicable to a prospective shipment",
    description:
      "Returns coupon codes valid for the given shipment payload. NOTE: documented as GET but requires a full shipment body (same shape as submit-orders).",
    method: "GET",
    path: "shipment/get_coupon_list",
    body: "json",
    bodyRequired: true,
    docNote: "GET-with-body endpoint. The CLI sends the JSON body on a GET request.",
    schema: obj({ shipment: arr(obj({}), "Same shape as submit-orders shipment[].") }, ["shipment"]),
  },

  {
    id: "shipment.submit",
    group: "shipment",
    command: "submit",
    aliases: ["submit-orders"],
    topLevelAlias: "ship",
    summary: "Submit (create & pay) one or more shipment orders",
    description:
      "Creates standard shipment orders and deducts the cost from your wallet. Returns AWB numbers and label URLs. Supports COD, insurance, tracking notifications, awb branding and coupons. Use --dry-run to preview the request body without sending.",
    method: "POST",
    path: "shipment/submit_orders",
    mutating: true,
    body: "json",
    bodyRequired: true,
    schema: obj(
      {
        coupon_codes: arr(str(), "Optional coupon codes to apply."),
        shipment: arr(
          obj(
            {
              reference: str("Your reference"),
              service_id: str("From a quotation, e.g. EP-CS0XXXXXX"),
              collection_date: str("YYYY-MM-DD"),
              customer_reference_no: str(),
              weight: num("kg"),
              height: num("cm"),
              length: num("cm"),
              width: num("cm"),
              item: arr(itemSchema),
              sender: addressSchema,
              receiver: addressSchema,
              // Drop-off (vs pickup) is selected via sender/receiver.point_code (see addressSchema),
              // NOT a top-level field. Insurance is feature.add_on_easy_cover or an insurance[] array.
              insurance: arr(
                obj(
                  { insurance_service_id: str("From `ep shipment insurance-quote`"), charge_amount: num(), currency_code: str() },
                  ["insurance_service_id"],
                ),
                "Optional EasyCover insurance per shipment.",
              ),
              feature: obj({
                add_on_easy_cover: bool("Add EasyCover insurance to this shipment"),
                sms_tracking: bool(),
                email_tracking: bool(),
                whatsapp_tracking: bool(),
                awb_branding: obj({ enable: bool() }),
                cod: obj({ cod_amount: num(), cod_currency: str() }),
                courier_ddp: obj({ enable: bool(), parcel_category_id: num() }),
              }),
            },
            ["service_id", "collection_date", "weight", "height", "length", "width", "item", "sender", "receiver"],
          ),
        ),
      },
      ["shipment"],
    ),
    example: {
      shipment: [
        {
          service_id: "EP-CS0XXXXXX",
          collection_date: "2026-06-10",
          weight: 1,
          height: 10,
          length: 20,
          width: 15,
          item: [{ content: "T-shirt", weight: 1, height: 5, length: 20, width: 15, currency_code: "MYR", value: 50, quantity: 1 }],
          sender: { name: "Alice", phone_number_country_code: "MY", phone_number: "0123456789", address_1: "1 Jln A", postcode: "11950", city: "Penang", country_code: "MY", subdivision_code: "MY-07" },
          receiver: { name: "Bob", phone_number_country_code: "MY", phone_number: "0198765432", address_1: "2 Jln B", postcode: "55100", city: "Kuala Lumpur", country_code: "MY", subdivision_code: "MY-14" },
          feature: {},
        },
      ],
    },
  },

  {
    id: "shipment.list",
    group: "shipment",
    command: "list",
    topLevelAlias: "shipments",
    summary: "List shipments (newest first), with filters and cursor paging",
    description: "Cursor-paginated. Use --page-all to fetch every page, --page-limit N to cap pages.",
    method: "POST",
    path: "shipment/list",
    body: "json",
    bodyRequired: false,
    schema: obj({
      limit: num("Default 50, max 250"),
      before_shipment_number: str("Cursor: pass the previous page's last shipment_number"),
      shipment_status_code: str(),
      date_from: str("YYYY-MM-DD (collection date)"),
      date_to: str("YYYY-MM-DD"),
    }),
    pagination: { cursorField: "before_shipment_number", nextCursor: paginationCursor("next_shipment_number") },
    example: { limit: 20 },
  },

  {
    id: "shipment.details",
    group: "shipment",
    command: "details",
    summary: "Get full details for a single shipment",
    method: "POST",
    path: "shipment/details",
    body: "json",
    bodyRequired: true,
    schema: obj({ shipment_number: str("e.g. ES-2606-XXXXX") }, ["shipment_number"]),
    example: { shipment_number: "ES-2606-00001" },
  },

  {
    id: "shipment.cancel",
    group: "shipment",
    command: "cancel",
    summary: "Cancel one or more shipments (bulk)",
    description:
      "Cancellable only within 7 days of the collection date and before driver pickup; refunds to your credit wallet. Returns HTTP 200 even if some items fail — check each item's status. Use --dry-run to preview.",
    method: "POST",
    path: "shipment/cancel",
    mutating: true,
    body: "json",
    bodyRequired: true,
    schema: obj(
      { cancel_list: arr(obj({ shipment_number: str(), remark: str("Reason for cancellation") }, ["shipment_number", "remark"])) },
      ["cancel_list"],
    ),
    example: { cancel_list: [{ shipment_number: "ES-2606-00001", remark: "Customer changed mind" }] },
  },

  {
    id: "shipment.track",
    group: "shipment",
    command: "track",
    aliases: ["tracking"],
    topLevelAlias: "track",
    summary: "Get real-time tracking status for AWB numbers (max 50)",
    description: "Returns the latest status plus a chronological status_log per AWB. Up to 50 AWBs per request.",
    method: "POST",
    path: "shipment/tracking_status",
    body: "json",
    bodyRequired: true,
    schema: obj({ awb_numbers: arr(str(), "Up to 50 AWB numbers") }, ["awb_numbers"]),
    example: { awb_numbers: ["EP1234567890"] },
    examples: [`ep track --data '{"awb_numbers":["EP1234567890"]}'`, `ep +track EP1234567890 EP0987654321   # shortcut`],
  },

  {
    id: "shipment.insurance-quote",
    group: "shipment",
    command: "insurance-quote",
    summary: "Get insurance pricing for prospective shipments (batch)",
    method: "POST",
    path: "insurance_quotations",
    body: "json",
    bodyRequired: true,
    schema: obj(
      {
        list: arr(
          obj(
            {
              courier_id: str(),
              currency_code: str(),
              from_postcode: str(),
              from_country: str("ISO alpha-2"),
              to_postcode: str(),
              to_country: str("ISO alpha-2"),
              shipment_weight: num("kg"),
              shipment_item: arr(obj({ value: num(), quantity: num(), currency_code: str() }, ["value", "quantity", "currency_code"])),
            },
            ["courier_id", "from_postcode", "from_country", "to_postcode", "to_country", "shipment_weight"],
          ),
        ),
      },
      ["list"],
    ),
    example: {
      list: [
        {
          courier_id: "EP-CR0XXXX",
          currency_code: "MYR",
          from_postcode: "11950",
          from_country: "MY",
          to_postcode: "55100",
          to_country: "MY",
          shipment_weight: 1,
          shipment_item: [{ value: 200, quantity: 1, currency_code: "MYR" }],
        },
      ],
    },
  },
];
