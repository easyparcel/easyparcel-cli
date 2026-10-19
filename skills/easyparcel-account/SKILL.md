---
name: easyparcel-account
description: List the EasyParcel accounts and organizations a login can act on, pick one, and check the account profile (default pickup/billing/delivery addresses) and wallet / credit balance using the `ep` CLI. Use when the user asks about their EasyParcel accounts, balance, credits, account details, or default addresses.
---

# EasyParcel CLI — Account & wallet

Read `easyparcel-shared` first.

## Which account? (do this first when the login covers several)
```
ep account list                # ACCOUNT_ID NAME TYPE COUNTRY ORGANISATION TOKEN_USABLE
ep account use <account_id>    # store a default for this profile (or pass --account <id> per call)
ep org list                    # ORG_ID REF NAME ROLE WHATSAPP AI_AGENT
```
Every command below accepts `--account <id>`; currency follows the account (MY → MYR, SG → SGD).
If a command answers "This login covers all your accounts. Name one…", list the accounts and pass one.
MCP: `ep_account_list`, then `account_id` on `ep_account_wallet` / `ep_account_info`.

## Wallet balance
```
ep wallet [--account <id>]
```
Returns `data.wallet[]` (credit balance + currency) and `data.free_credit_wallet[]`.

## Account profile
```
ep account info [--account <id>]
```
Returns `data.account` (`name`, `account_type`) and `data.address` with default
`pickup_address`, `billing_address`, `delivery_address` — handy as `sender` defaults
when building a shipment. `ep auth whoami` is a shortcut for the same data.

Use the saved pickup address fields (name, phone, address1/2, postcode, city,
`province_code`, country_code) to pre-fill the `sender` of a `shipment submit`.
