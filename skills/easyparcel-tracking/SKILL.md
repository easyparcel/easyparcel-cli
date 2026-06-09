---
name: easyparcel-tracking
description: Track parcels by AWB number and interpret EasyParcel shipment status codes using the `ep` CLI. Use when the user asks where a parcel is, wants delivery status, or wants to track one or many AWB / tracking numbers.
---

# EasyParcel CLI — Tracking

Read `easyparcel-shared` first.

## Track
Shortcut (table of latest status per AWB):
```
ep +track EP1234567890 EP0987654321
```
Full command (up to **100** AWBs per call):
```
ep shipment track --data '{"awb_numbers":["EP1234567890"]}'
```

## Response
`data.results[]`, each with:
- `status`: `"success"` or `"not_found"`.
- `latest_shipment_status_code`, `latest_tracking_status`, `latest_event_date`.
- `status_log[]`: chronological events `{event_date, shipment_status_code, tracking_status, location}`.

Unknown AWBs come back as `status: "not_found"` inside a 200 response — check per item.

## Status codes
The Tracking endpoint and Webhooks use **different** code tables; do not assume they match. See `ep reference tracking-status` and `ep reference webhook-status`. Tracking codes:
1 Order Created · 2 Payment Confirmed · 3 Ready for Collection · 4 Item Collected · 5 In Transit to Hub · 6 Processing at Hub · 7 Schedule In Arrangement · 8 Out for Delivery · 9 Delivered · 10 Delivery Failed · 11 Return to Sender.

If you only have a `shipment_number` (ES-…), get its `awb_number` via `ep shipment details --data '{"shipment_number":"ES-2606-00001"}'` first.
