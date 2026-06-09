---
name: easyparcel-shipping
description: Quote, book, list, cancel and insure standard parcel shipments, and find couriers / drop-off points, using the EasyParcel CLI (`ep`). Use when the user wants to ship a parcel, compare courier rates, create or pay for a shipping order, get an AWB / label, cancel a shipment, or look up couriers in Malaysia or Singapore.
---

# EasyParcel CLI — Standard shipping

Read `easyparcel-shared` first for auth, `--data`, output and exit-code conventions.

## Typical workflow: quote → submit → label → (track/cancel)

### 1. Get rates
Quick check (human-friendly table):
```
ep +rates --from 11950 --to 55100 --weight 1.5
```
Full control (`shipment quote`, batch-capable). Body shape: `ep describe shipment.quote`.
```
ep shipment quote --data @quote.json
```
The response lists `quotations[]` per shipment; each has `courier.service_id`, `courier.courier_name`, `pricing.total_amount`, and `features[]` (COD, tracking, insurance, DDP). **You need a `service_id` to submit an order.**

### 2. (Optional) Coupons, insurance, drop-off
- Coupons for a prospective shipment: `ep shipment coupon-list --data @order.json` → apply by adding `"coupon_codes": ["CODE"]` to the submit body.
- Insurance pricing: `ep shipment insurance-quote --data @ins.json` → take `insurance_service_id` and add it to the submit body.
- Couriers for a country: `ep courier list --data '{"country_code":"MY"}'`.
- Drop-off points: `ep courier dropoff-points --data @dropoff.json` → use `point_id` as `dropoff_point_id` and set `"collection_method":"dropoff"`.

### 3. Submit the order (MUTATING — spends wallet credit)
Always preview first:
```
ep shipment submit --dry-run --data @order.json
ep shipment submit --data @order.json
```
Required per shipment: `service_id`, `collection_date` (YYYY-MM-DD), `weight`, `height`, `length`, `width`, `item[]`, `sender`, `receiver`, `feature`. See `ep describe shipment.submit` for the full schema; `examples/submit-orders.json` is a working template.

The response returns `order_number`, and per shipment: `shipment_number` (ES-YYMM-XXXXX), `awb_number`, `awb_url` (label PDF), `tracking_url`. **Check each `shipments[].status`** — submit is a batch and individual items can fail with `errors[]`.

Simple single domestic parcel? Use the shortcut:
```
ep +ship --service-id EP-CS0XXXX --collection-date 2026-06-10 --weight 1 \
  --sender-name "Alice" --sender-phone 0123456789 --sender-address "1 Jln A" --sender-city Penang --sender-postcode 11950 --sender-state MY-07 \
  --receiver-name "Bob" --receiver-phone 0198765432 --receiver-address "2 Jln B" --receiver-city "Kuala Lumpur" --receiver-postcode 55100 --receiver-state MY-14 \
  --dry-run
```

### 4. Manage shipments
- List (newest first, paginated): `ep shipment list --data '{"limit":20}'`  ·  all pages: `ep shipment list --page-all --data '{"limit":250}'`
- Details: `ep shipment details --data '{"shipment_number":"ES-2606-00001"}'`
- Cancel (MUTATING, bulk): `ep shipment cancel --dry-run --data @cancel.json` then without `--dry-run`. Only allowed within 7 days of collection date and before pickup; refunds to credit wallet.

## Tips
- DDP (international duties prepaid): add `parcel_category_id` to quote items and `feature.courier_ddp.{enable,parcel_category_id}` when submitting.
- COD: add `feature.cod.{cod_amount,cod_currency}`.
- Notifications: `feature.{sms_tracking,email_tracking,whatsapp_tracking}: true`.
- State codes are ISO 3166-2 (e.g. `MY-07` = Penang). See `ep reference states`.
