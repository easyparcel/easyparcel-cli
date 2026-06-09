import { type Operation, str, obj } from "./types";

export const courierOperations: Operation[] = [
  {
    id: "courier.list",
    group: "courier",
    command: "list",
    summary: "List couriers available for a country",
    description: "NOTE: documented as GET but requires a JSON body { country_code }. Supported: MY, SG.",
    method: "GET",
    path: "courier/list",
    body: "json",
    bodyRequired: false,
    docNote: "GET-with-body endpoint. The CLI sends the JSON body on a GET request. country_code is an optional filter.",
    schema: obj({ country_code: str("Optional ISO 3166-1 alpha-2 filter, e.g. MY or SG") }),
    example: { country_code: "MY" },
    examples: [`ep courier list --data '{"country_code":"MY"}'`],
  },
  {
    id: "courier.dropoff-points",
    group: "courier",
    command: "dropoff-points",
    summary: "List physical drop-off points for a courier near a location",
    method: "POST",
    path: "courier/get_courier_dropoff_points",
    body: "json",
    bodyRequired: true,
    schema: obj(
      {
        courier_id: str(),
        country_code: str("ISO alpha-2"),
        postcode: str("Optional"),
        city: str("Optional"),
        state_code: str("Optional ISO 3166-2, e.g. MY-07"),
      },
      ["courier_id", "country_code"],
    ),
    example: { courier_id: "EP-CR0XXXX", country_code: "MY", postcode: "11950", city: "Penang", state_code: "MY-07" },
  },
];
