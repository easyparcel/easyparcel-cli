# EasyParcel CLI

Ship parcels, compare courier rates, track deliveries, and check your wallet — straight
from your terminal or through your favourite AI assistant.

`easyparcel-cli` is the command‑line tool for the [EasyParcel](https://easyparcel.com)
Open API (Malaysia & Singapore). It's friendly for people **and** built for AI agents
(ChatGPT/Claude‑style tools), with clean output and a one‑step login.

```bash
ep +rates --from 11950 --to 55100 --weight 1.5    # compare courier prices
ep +track EP123456789                              # where's my parcel?
ep wallet                                          # how much credit do I have?
```

> The command is available under three names — `ep`, `easyparcel`, and `easyparcel-cli` —
> they all do the same thing. We'll use `ep` below.

---

## Install

**With npm (needs [Node.js](https://nodejs.org) 18+):**
```bash
npm install -g @easyparcel/cli
```

**No Node? Download a ready‑to‑run app** from the [Releases page](https://github.com/easyparcel/easyparcel-cli/releases)
— pick your system, then run it directly:
- Windows: `easyparcel-windows-x64.exe`
- macOS (Apple Silicon): `easyparcel-darwin-arm64`
- macOS (Intel): `easyparcel-darwin-x64`
- Linux: `easyparcel-linux-x64`

On macOS/Linux, make it runnable first: `chmod +x easyparcel-*`.

---

## 1. Log in (one step)

```bash
ep auth login
```
Your browser opens, you approve, done — tokens are saved in your OS keychain (or a private
file where there is none). No app registration, no API keys to copy.

No browser on this machine (SSH, a server, a container)? Use the device code — the CLI shows a
short code, you approve it from any browser, and it picks this up automatically:
```bash
ep login --device
```
The approval page names the computer (`EasyParcel CLI on <host>`); set `EASYPARCEL_DEVICE_NAME`
to show a different label. Only approve codes you started yourself.

Check anytime, and sign out (this also revokes the session on the server):
```bash
ep auth status
ep logout
```

**Have more than one EasyParcel account** (e.g. a Malaysia account in MYR and a Singapore
account in SGD)? Sign in once and choose **All my shipping accounts** on the approval page.
Then list what the login reaches and name the account per command:
```bash
ep account list                                   # ACCOUNT_ID NAME TYPE COUNTRY …
ep +rates --account 123456 --from 049483 --to 018956 --weight 1   # quotes in SGD
ep wallet --account 654321                        # MYR balance
```
Or store a default for this profile, so `--account` is only needed to pick another one:
```bash
ep account use 123456        # ep account use --clear to drop it
```
The account is chosen in this order: `--account` > `EASYPARCEL_ACCOUNT_ID` > the profile
default > none. Organizations (WhatsApp, AI agent) work the same way: `ep org list`,
`--organization <id|ref>`, `EASYPARCEL_ORGANIZATION_ID`, `ep org use <id|ref>`.
If a command answers *"This login covers all your accounts. Name one…"*, it needs an account.

`ep auth login --all` and `ep auth sync` (one profile per account) still work for a
release, with a deprecation notice; prefer `--account`.

---

## 2. Everyday commands

| What you want | Command |
|---|---|
| Compare courier rates | `ep +rates --from <postcode> --to <postcode> --weight <kg>` |
| Track a parcel | `ep +track <AWB> [<AWB> …]` |
| Wallet balance | `ep wallet` |
| Your account info | `ep account info` |
| Find a saved address | `ep +address "john"` |
| Book a simple parcel | `ep +ship --service-id … --collection-date … --weight … --sender-… --receiver-…` |
| List your shipments | `ep shipments` |

Anything that spends credit (booking, cancelling) supports **`--dry-run`** — it shows
exactly what would be sent, without doing it:
```bash
ep shipment submit --dry-run --data @order.json
```

Prefer a table or spreadsheet? Add `--format table` or `--format csv` (default is JSON).

Not sure what a command needs? Ask the CLI:
```bash
ep --help                 # everything
ep shipment --help        # shipping commands
ep describe               # full machine‑readable list (handy for AI)
```

---

## 3. Use it with AI (ChatGPT / Claude / Cursor)

This is what the CLI is really built for. Two ways:

### a) Plug it into an AI assistant as tools (recommended)
Add this to your AI client's MCP config (Claude Desktop, Claude Code, Cursor, …):
```jsonc
{
  "mcpServers": {
    "easyparcel": {
      "command": "npx",
      "args": ["-y", "@easyparcel/cli", "mcp"]
    }
  }
}
```
Restart the app, log in once with `ep auth login`, and then just chat:
*"Compare rates from 11950 to 55100 for a 1 kg parcel"* — the assistant runs it for you.

With an all-accounts login the assistant first calls **`ep_account_list`** (and
**`ep_organization_list`** for WhatsApp / AI-agent work), then passes **`account_id`**
(or `organization_id`) on each tool call — every tool accepts both. Without them the
profile default from `ep account use` (or `EASYPARCEL_ACCOUNT_ID`) applies.

### b) Teach a coding assistant how to use it (Claude Code / Cursor "Skills")
```bash
ep skills install          # adds EasyParcel skills to this project
ep skills install --user   # …or for all your projects
```

### c) Host it as a remote connector (ChatGPT apps / web MCP)
Run the server over HTTP instead of stdio and point a remote MCP client at it.

**With OAuth (for ChatGPT connectors / public listing):**
```bash
ep mcp --http --host 0.0.0.0 --port 8790 --oauth --public-url https://mcp.example.com
```
This turns the server into an OAuth 2.1 authorization‑server *proxy*: ChatGPT does
discovery, dynamic client registration and the login flow against it, and it relays the
actual sign‑in to EasyParcel's OAuth — each user logs in with their own EasyParcel
account. Put it behind HTTPS and register `https://mcp.example.com/mcp` as the connector
URL. (The EasyParcel app must allow `https://mcp.example.com/oauth/callback` as a
redirect URI.)

**With a pre‑issued token (simplest, for your own use):**
```bash
ep mcp --http --require-auth
```
Clients authenticate per request with their **own** EasyParcel token
(`Authorization: Bearer <token>`). Drop `--require-auth` for local testing (it then uses
your logged‑in credentials).

When a client's token has expired (or EasyParcel rejects it), the server answers HTTP 401
with `WWW-Authenticate: … error="invalid_token"` so the client refreshes and retries.
Tool arguments `account_id` / `organization_id` choose the target per call; the server's
own defaults never apply to a client's token.

---

## 4. For automation / servers (no browser)

Set a token in the environment and the CLI runs fully unattended:
```bash
export EASYPARCEL_ACCESS_TOKEN=...     # (and EASYPARCEL_REFRESH_TOKEN to auto‑renew)
export EASYPARCEL_ACCOUNT_ID=123456    # the account to act on (personal access tokens / all-accounts logins)
ep wallet
```
To check a token before a job uses it, pipe it in — it is validated (it reports how many
accounts it can reach) and never written to disk:
```bash
printf %s "$EASYPARCEL_TOKEN" | ep login --with-token
```
`ep login --non-interactive` refuses anything that would wait for a person (browser or device
approval), so a misconfigured job fails fast instead of hanging.

---

## Updating

```bash
ep upgrade            # update to the latest version  (`ep update` works too)
ep upgrade --check    # just check if there's a newer version
```
If you installed with npm, this runs `npm i -g @easyparcel/cli@latest`. For a downloaded
binary, it points you to the latest release. The `npx … mcp` setup auto‑uses the latest.

---

## Good to know

- **Where things are saved:** config in `~/.easyparcel/`; login tokens in the OS keychain
  (`ep auth status` shows `"storage"`), or in `~/.easyparcel/credentials.json` (readable only by
  you) on machines without one.
- **Demo vs live:** you're using whichever EasyParcel account you logged in with.
- **Exit codes** (for scripts): `0` ok · `3` not logged in · `4` not found · `5` bad input ·
  `6` rate‑limited · `7` some batch items failed.
- **Coverage:** couriers for Malaysia (MY) and Singapore (SG).

## Building / contributing

See [AGENTS.md](AGENTS.md) (architecture) and [PUBLISHING.md](PUBLISHING.md) (release steps).

```bash
npm install
npm run dev -- <args>     # run from source
npm run build             # bundle
npm run build:exe         # standalone binaries for all platforms
```

## License

MIT © EasyParcel
