import { type Operation, str, num, arr, obj } from "./types";
import type { Envelope } from "../core/types";

function nextBookingCursor(env: Envelope): string | undefined {
  const p = (env.pagination ?? (env.data as any)?.pagination) as any;
  if (p && typeof p === "object" && p.has_more) {
    const c = p.next_booking_number ?? p.next_page_token;
    if (c) return String(c);
  }
  return undefined;
}

const coordinates = obj({ latitude: num(), longitude: num() }, ["latitude", "longitude"]);

// Full on-demand order body — shared by `ondemand.order` and `ondemand.coupon-list`
// (the coupon endpoint validates the same required fields as ordering).
const ondemandOrderBody = obj(
  {
    coupon_codes: arr(str()),
    origin_country: str("ISO alpha-2"),
    ondemand_service_id: str('e.g. "EP-CS0I"'),
    schedule_pickup_date: str(),
    schedule_pickup_time: str(),
    time_zone: str("Note: underscore form here (vs quote's timezone)"),
    metadata: obj({ quotationId: str() }, ["quotationId"]),
    waypoint: arr(
      obj({
        point: num("0 = pickup, 1 = dropoff"),
        type: str(),
        remark: str(),
        coordinates,
        item: arr(
          obj({
            quantity: str("string"),
            description: str(),
            dimensions: obj({ height: str(), width: str(), length: str(), weight: str() }),
          }),
        ),
        shipment_info: obj(
          { name: str(), email: str(), phone_number_country_code: str(), phone_number: str(), address: str() },
          ["name", "phone_number_country_code", "phone_number", "address"],
        ),
      }),
    ),
  },
  ["origin_country", "ondemand_service_id", "metadata", "waypoint"],
);

export const ondemandOperations: Operation[] = [
  {
    id: "ondemand.quote",
    group: "ondemand",
    command: "quote",
    aliases: ["quotation"],
    summary: "Get on-demand (same-day) delivery quotes by geocoordinates",
    description: "Requires at least 2 waypoints (pickup + dropoff). Returns quotations with a quotationId used when ordering.",
    method: "POST",
    path: "ondemand/quotation",
    body: "json",
    bodyRequired: true,
    schema: obj(
      {
        schedule_pickup_date: str("YYYY-MM-DD (optional)"),
        schedule_pickup_time: str("HH:MM:SS (optional)"),
        timezone: str('e.g. "Asia/Kuala_Lumpur"'),
        waypoint: arr(
          obj(
            { coordinates, address: str(), type: str('"pickup" or "dropoff"') },
            ["coordinates", "type"],
          ),
          "At least 2 waypoints.",
        ),
      },
      ["waypoint"],
    ),
    example: {
      waypoint: [
        { coordinates: { latitude: 3.1579, longitude: 101.7123 }, type: "pickup" },
        { coordinates: { latitude: 3.139, longitude: 101.6869 }, type: "dropoff" },
      ],
    },
  },
  {
    id: "ondemand.order",
    group: "ondemand",
    command: "order",
    summary: "Book an on-demand delivery from a prior quotation",
    description: "Uses metadata.quotationId from `ondemand quote`. Deducts from wallet. Use --dry-run to preview.",
    method: "POST",
    path: "ondemand/order",
    mutating: true,
    body: "json",
    bodyRequired: true,
    schema: ondemandOrderBody,
  },
  {
    id: "ondemand.coupon-list",
    group: "ondemand",
    command: "coupon-list",
    summary: "List coupons for a prospective on-demand order",
    method: "GET",
    path: "ondemand/get_coupon_list",
    body: "json",
    bodyRequired: true,
    docNote: "GET-with-body endpoint (same body shape as `ondemand order`).",
    schema: ondemandOrderBody,
  },
  {
    id: "ondemand.cancel",
    group: "ondemand",
    command: "cancel",
    summary: "Cancel a single on-demand booking",
    method: "POST",
    path: "ondemand/cancel",
    mutating: true,
    body: "json",
    bodyRequired: true,
    schema: obj({ booking_id: str('e.g. "EOD-150"') }, ["booking_id"]),
    example: { booking_id: "EOD-150" },
  },
  {
    id: "ondemand.list",
    group: "ondemand",
    command: "list",
    summary: "List on-demand orders (cursor-paginated)",
    method: "POST",
    path: "ondemand/list",
    body: "json",
    bodyRequired: false,
    schema: obj({
      limit: num("Default 10, max 250"),
      before_booking_number: str("Cursor"),
      shipment_status_code: str(),
      date_from: str("YYYY-MM-DD"),
      date_to: str("YYYY-MM-DD"),
    }),
    pagination: { cursorField: "before_booking_number", nextCursor: nextBookingCursor },
    example: { limit: 20 },
  },
  {
    id: "ondemand.details",
    group: "ondemand",
    command: "details",
    summary: "Get details for a single on-demand booking",
    method: "POST",
    path: "ondemand/details",
    body: "json",
    bodyRequired: true,
    schema: obj({ booking_id: str('e.g. "EOD-150"') }, ["booking_id"]),
    example: { booking_id: "EOD-150" },
  },
];
