---
name: easyparcel-account
description: Check the EasyParcel account profile (default pickup/billing/delivery addresses) and wallet / credit balance using the `ep` CLI. Use when the user asks about their EasyParcel balance, credits, account details, or default addresses.
---

# EasyParcel CLI — Account & wallet

Read `easyparcel-shared` first.

## Wallet balance
```
ep wallet
```
Returns `data.wallet[]` (credit balance + currency) and `data.free_credit_wallet[]`.

## Account profile
```
ep account info
```
Returns `data.account` (`name`, `account_type`) and `data.address` with default
`pickup_address`, `billing_address`, `delivery_address` — handy as `sender` defaults
when building a shipment. `ep auth whoami` is a shortcut for the same data.

Use the saved pickup address fields (name, phone, address1/2, postcode, city,
`province_code`, country_code) to pre-fill the `sender` of a `shipment submit`.
