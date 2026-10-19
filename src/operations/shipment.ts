import { type Operation, str, num, bool, arr, obj, addressSchema } from "./types";

/** `ep shipment parcel-categories` rows: id → name (used as parcel_category_id for DDP). */
function parcelCategoryRows(data: unknown): Record<string, unknown>[] {
  const list = Array.isArray(data) ? data : [];
  return list.map((c: any) => ({ ID: c?.id ?? "", NAME: c?.name ?? "" }));
}
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
              parcel_category_id: num("From `ep shipment parcel-categories` (DDP)"),
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
    prerequisites: [
      {
        param: "shipment[].parcel_category_id",
        from: "shipment.parcel-categories",
        field: "[].id",
        when: "international DDP quotes",
      },
    ],
    provides: ["[].quotations[].courier.service_id", "[].quotations[].courier.courier_id"],
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
    schema: obj({ shipment: arr(obj({ service_id: str("From `ep shipment quote`") }), "Same shape as submit-orders shipment[].") }, ["shipment"]),
    prerequisites: [{ param: "shipment[].service_id", from: "shipment.quote", field: "[].quotations[].courier.service_id" }],
    provides: ["coupons[].coupon_code"],
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
        coupon_codes: arr(str(), "Optional coupon codes to apply (from `ep shipment coupon-list`)."),
        shipment: arr(
          obj(
            {
              reference: str("Your reference"),
              service_id: str("From `ep shipment quote` (quotations[].courier.service_id), e.g. EP-CS0XXXXXX"),
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
    prerequisites: [
      { param: "shipment[].service_id", from: "shipment.quote", field: "[].quotations[].courier.service_id", note: "Quote the same route and weight first; the service id picks courier and price." },
      { param: "coupon_codes", from: "shipment.coupon-list", field: "coupons[].coupon_code", when: "paying with a coupon" },
      { param: "shipment[].insurance[].insurance_service_id", from: "shipment.insurance-quote", field: "[].insurance_quotations[].insurance_service_id", when: "adding insurance" },
      { param: "shipment[].sender.point_code", from: "courier.dropoff-points", field: "[].point_id", when: "dropping the parcel off instead of a pickup" },
      { param: "shipment[].feature.courier_ddp.parcel_category_id", from: "shipment.parcel-categories", field: "[].id", when: "international DDP" },
      {
        param: "shipment[].receiver",
        from: "address.search",
        field: "[]",
        when: "shipping to a saved address",
        note: "Map address1 → address_1, province_code → subdivision_code, phone_country_code → phone_number_country_code.",
      },
    ],
    provides: ["[].order_number", "[].shipments[].shipment_number", "[].shipments[].awb_number"],
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
    provides: ["[].shipment_number", "[].awb_number"],
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
    prerequisites: [
      { param: "shipment_number", from: "shipment.list", field: "[].shipment_number" },
      { param: "shipment_number", from: "shipment.submit", field: "[].shipments[].shipment_number", when: "just booked" },
    ],
    provides: ["[].awb_number"],
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
    prerequisites: [{ param: "cancel_list[].shipment_number", from: "shipment.list", field: "[].shipment_number" }],
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
    prerequisites: [
      { param: "awb_numbers", from: "shipment.list", field: "[].awb_number" },
      { param: "awb_numbers", from: "shipment.submit", field: "[].shipments[].awb_number", when: "just booked" },
    ],
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
    prerequisites: [
      { param: "list[].courier_id", from: "shipment.quote", field: "[].quotations[].courier.courier_id" },
      { param: "list[].courier_id", from: "courier.list", field: "[].courier_id" },
    ],
    provides: ["[].insurance_quotations[].insurance_service_id"],
  },

  {
    id: "shipment.parcel-categories",
    group: "shipment",
    command: "parcel-categories",
    aliases: ["parcel-category-list"],
    summary: "List parcel categories (ids for DDP quotes and orders)",
    description:
      "Returns { id, name } per parcel category. Use the id as shipment[].parcel_category_id when quoting and as feature.courier_ddp.parcel_category_id when submitting a DDP shipment.",
    method: "GET",
    path: "parcel_category/list",
    body: "none",
    provides: ["[].id"],
    humanTable: { columns: ["ID", "NAME"], rows: parcelCategoryRows },
  },

  {
    id: "shipment.bulk-awbs",
    group: "shipment",
    command: "bulk-awbs",
    summary: "Generate one consignment-note PDF for several AWBs (returns the file URL)",
    description:
      "Merges the consignment notes of your own shipments into one PDF and returns its URL in `data`. AWBs of other accounts are skipped; none found → 400 \"Awb not found\".",
    method: "GET",
    path: "shipment/bulk_awbs",
    body: "json",
    bodyRequired: true,
    docNote: "GET-with-body endpoint. The CLI sends the JSON body on a GET request.",
    schema: obj(
      {
        awb: arr(str(), "AWB numbers (from `ep shipment list` / `ep shipment submit`)"),
        awb_rename: { type: "object", additionalProperties: { type: "string" }, description: "Optional { <awb>: <file label> } map" },
      },
      ["awb"],
    ),
    example: { awb: ["EP1234567890", "EP0987654321"] },
    prerequisites: [
      { param: "awb", from: "shipment.list", field: "[].awb_number" },
      { param: "awb", from: "shipment.submit", field: "[].shipments[].awb_number", when: "just booked" },
    ],
  },
];
