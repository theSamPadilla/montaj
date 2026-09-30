---
name: mcp
description: "MCP server mode for montaj — load when running as an MCP client (e.g. Claude Desktop)"
step: false
---

# Montaj MCP

Montaj exposes itself as an MCP server over stdin/stdout.

## Starting the server

```bash
montaj mcp
# or directly:
node mcp/server.js
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "montaj": {
      "command": "montaj",
      "args": ["mcp"]
    }
  }
}
```

## What the server exposes

One tool: `render`, which renders a project to MP4. Everything else runs through the CLI (`montaj <command>`; `montaj --help` lists them) from a shell: create the project with `montaj run` and run each step with its command. Over HTTP, `montaj serve` runs a step with `POST /api/steps/<name>`. The Montaj app's connector adds its own `run_step` and project tools.

Follow the headless CLI loop from the root skill. Write project state to `project.json` in the project directory as you go.

## Logging progress

There is no `log` tool. Log with the CLI before each step: `montaj log --project <id> "<short, human-readable message>"`. Say what you're doing, not why. If a `montaj serve` the project belongs to is running, the message appears live in the UI's activity feed; otherwise it's printed to stderr. This is the same `_contract` "log `<message>`" verb every other Montaj interface performs (see `skills/_contract/SKILL.md`).
