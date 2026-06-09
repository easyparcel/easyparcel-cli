# Publishing & Distribution

How to release the EasyParcel CLI and how people consume it (especially via AI).

## 0. One-time setup before the first publish

1. **Replace the built-in OAuth client.** In `src/core/config.ts`, set `DEFAULT_CLIENT_ID`
   to the official **"EasyParcel CLI"** public app's client id (registered with redirect
   URI `http://localhost:8788/callback` and added to `public_client_ids` in the core API).
   Keep `DEFAULT_CLIENT_SECRET = ""`.
2. **Decide the package name.** `@easyparcel/cli` needs the `easyparcel` npm org (you must
   own it). No org? Use an unscoped name like `easyparcel-cli` and drop `publishConfig`.
3. **Set the real repo URLs.** Update `repository` / `homepage` / `bugs` in `package.json`
   and the binary base URL (see step 3) to wherever you host releases.
4. Have an npm account with publish rights: `npm login`.

## 1. Publish to npm (primary distribution)

```bash
npm run typecheck
npm publish            # prepublishOnly runs the build; scoped public uses publishConfig.access
```

Users then:
```bash
npm i -g @easyparcel/cli      # or: npm i -g easyparcel-cli
ep auth login
ep quote --data @quote.json
```

> The published tarball ships `dist/`, `bin/`, `skills/`, `README`, `LICENSE` (the `files`
> whitelist). devDependencies (bun, tsup, vitest, …) are **not** shipped to users.

## 2. Easiest way for people to use it via AI — MCP over npx (zero install)

Tell users to add this to their AI client (Claude Desktop / Claude Code / Cursor) config:
```jsonc
{
  "mcpServers": {
    "easyparcel": {
      "command": "npx",
      "args": ["-y", "@easyparcel/cli", "mcp"],
      "env": { "EASYPARCEL_ACCESS_TOKEN": "<token, or run `npx @easyparcel/cli auth login` once>" }
    }
  }
}
```
`npx -y` fetches the package on demand — no install needed. The AI then calls the tools
(`ep_shipment_quote`, `ep_shipment_track`, `ep_account_wallet`, `ep_address_search`, …).

### Skills (Claude Code / Cursor)
```bash
ep skills install            # → ./.claude/skills (project)
ep skills install --user     # → ~/.claude/skills (all projects)
```
The skills are embedded in the package/binary, so this works offline and from the native binary too.

## 3. Native single-file binaries (no Node required)

Build self-contained executables for every platform (uses bun):
```bash
npm run build:exe            # dist/bin/easyparcel-{windows-x64.exe,darwin-arm64,darwin-x64,linux-x64,linux-arm64}
```
Upload those files to a **GitHub Release tagged `v<version>`** (matching `package.json`).
File names must stay exactly `easyparcel-<os>-<arch>[.exe]`.

Once a release exists, `npm install` auto-downloads the matching binary (via
`scripts/postinstall.mjs`) and the `bin/ep.mjs` launcher runs it (falling back to the
bundled JS if the download is unavailable). Override the source with
`EASYPARCEL_CLI_BINARY_BASEURL`, or skip with `EASYPARCEL_CLI_SKIP_DOWNLOAD=1`.

Users without Node can also just download the binary directly from the Release and run it.

## 4. Versioning

```bash
npm version patch      # bumps package.json; keep src/core/version.ts CLI_VERSION in sync
git tag / push, build:exe, upload binaries to the v<version> Release, then npm publish
```

## Summary of distribution channels
| Channel | Command for the user | Node needed? |
|---|---|---|
| npm global | `npm i -g @easyparcel/cli` → `ep …` | yes |
| AI via MCP | add the `npx … mcp` config block | yes (npx) |
| Skills | `ep skills install` | — |
| Native binary | download from GitHub Releases, run directly | **no** |
