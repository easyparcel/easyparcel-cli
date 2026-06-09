# EasyParcel CLI — AI Agent Skills

These are [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills) that teach
AI coding assistants (Claude Code, Cursor, etc.) how to drive the EasyParcel CLI (`ep`).

| Skill | Use it for |
|-------|------------|
| `easyparcel-shared` | Core conventions (auth, `--data`, output, exit codes). Referenced by the others. |
| `easyparcel-shipping` | Quote, submit, list, cancel, insure shipments; couriers & drop-off points. |
| `easyparcel-tracking` | Track AWBs and interpret status codes. |
| `easyparcel-ondemand` | Same-day / on-demand deliveries. |
| `easyparcel-account` | Account profile & wallet balance. |
| `easyparcel-einvoice` | Malaysia MyInvois e-invoices. |

## Install

Prerequisite: install the CLI and authenticate.

```bash
npm install -g @easyparcel/cli
ep auth login            # or export EASYPARCEL_ACCESS_TOKEN=...
```

**Project scope** (this repo / your project — committable):
```bash
mkdir -p .claude/skills
cp -r skills/easyparcel-* .claude/skills/
```

**Personal scope** (all your projects):
```bash
mkdir -p ~/.claude/skills
cp -r skills/easyparcel-* ~/.claude/skills/
```

On Windows (PowerShell):
```powershell
New-Item -ItemType Directory -Force .claude\skills | Out-Null
Copy-Item -Recurse skills\easyparcel-* .claude\skills\
```

Restart your assistant (or reload skills). When the user mentions shipping, tracking,
rates, AWBs, wallet balance, etc., the matching skill activates and the agent will use
`ep` commands — preferring `ep describe <op>` to discover exact parameters.

## Prefer the MCP server?

Instead of (or alongside) skills, expose every operation as a native tool:

```jsonc
// Claude Code / MCP client config
{ "mcpServers": { "easyparcel": { "command": "easyparcel", "args": ["mcp"] } } }
```
