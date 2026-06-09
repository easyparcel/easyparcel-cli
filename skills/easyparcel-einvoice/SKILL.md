---
name: easyparcel-einvoice
description: Submit Malaysia LHDN MyInvois e-invoices (and verify MyInvois access) through EasyParcel using the `ep` CLI. Use only for Malaysia e-Invoice / LHDN / MyInvois tax invoice submission.
---

# EasyParcel CLI — Malaysia e-Invoice (MyInvois / LHDN)

Read `easyparcel-shared` first. This feature must be enabled in the EasyParcel
Developer Hub for your app.

## 1. Verify access (do this before submitting)
```
ep einvoice verify-access --data '{"tin_no":"C1234567890","id_no":"201901000001","id_type":"BRN"}'
```
`id_type` ∈ `NRIC | PASSPORT | BRN | ARMY`. Success → `data.status: "success"`.

## 2. Submit invoices (MUTATING, bulk)
```
ep einvoice submit --dry-run --data @invoices.json
ep einvoice submit --data @invoices.json
```
Critical formatting rules (see `ep describe einvoice.submit`):
- `invoice_issue_date` (YYYY-MM-DD) and `invoice_issue_time` (HH:mm:ss) must be **UTC** (e.g. MYT 2:30pm → `06:30:00`).
- `order_currency` must be `"MYR"`.
- `state_code` is a **2-digit NUMERIC** code (e.g. `"07"` = Penang) — this is a *different* system from the `MY-07` ISO codes used elsewhere. Map with `ep reference states` (the `einvoice` column).
- Each `bulk[].items[]` needs `description`, `quantity`, `amount` (pre-tax), `tax_amount`.

Response: `data[]` per invoice with `status` and a `submission_id` (EP-MEI…). Check each item.
