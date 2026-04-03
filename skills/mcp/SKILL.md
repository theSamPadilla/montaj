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

## Using steps

Steps are MCP tool calls — not curl, not bash. The MCP host handles transport. Each montaj step is exposed as an MCP tool with the same name and params as the CLI commands.

Follow the headless CLI loop from the root skill. Clips, prompt, and workflow come in via MCP tool call params. Write project state to `project.json` in the project directory as you go.
