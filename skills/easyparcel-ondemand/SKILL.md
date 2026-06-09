---
name: easyparcel-ondemand
description: Quote and book on-demand / same-day deliveries (e.g. Lalamove, PandaGo) by geocoordinates, and list/cancel on-demand bookings, using the `ep` CLI. Use when the user wants same-day, instant, point-to-point or on-demand courier delivery rather than standard scheduled shipping.
---

# EasyParcel CLI — On-demand (same-day)

Read `easyparcel-shared` first. On-demand uses **geocoordinates** and at least two
waypoints (pickup + dropoff), not postcodes.

## Workflow: quote → order → (track via webhook) / cancel

### 1. Quote
```
ep ondemand quote --data @examples/ondemand-quote.json
```
Each quotation returns `metadata.quotationId`, `courier.service_id` (e.g. `EP-CS0I`), `transport` (vehicle type/limits) and `pricing`. Keep the `quotationId` and `service_id`.

### 2. Order (MUTATING)
```
ep ondemand order --dry-run --data @order.json
ep ondemand order --data @order.json
```
Body needs `origin_country`, `ondemand_service_id`, `metadata.quotationId`, and `waypoint[]` with `point` (0=pickup,1=dropoff), `coordinates`, `item[]`, and `shipment_info` (name/phone/address). See `ep describe ondemand.order`. Note quirks: `time_zone` (underscore) here vs `timezone` in quote. Returns `booking_id` (EOD-###), `order_number`, `tracking_url`.

### 3. Manage
- List: `ep ondemand list --data '{"limit":20}'` (cursor: `before_booking_number`; `--page-all` supported).
- Details: `ep ondemand details --data '{"booking_id":"EOD-150"}'`.
- Cancel (MUTATING, single): `ep ondemand cancel --data '{"booking_id":"EOD-150"}'`.
- Coupons: `ep ondemand coupon-list --data @order.json`.
