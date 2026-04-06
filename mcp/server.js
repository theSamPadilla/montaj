#!/usr/bin/env node
/**
 * montaj MCP server — exposes all CLI commands as MCP tools.
 *
 * Tool definitions are generated at startup by introspecting the CLI's argparse
 * parsers (cli/mcp_schema.py). Every tool is dispatched via:
 *
 *   python3 -m cli.main <command> [positionals] [flags] [--json]
 *
 * Communicates over stdin/stdout (no port, no HTTP).
 */
import { Server }                  from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport }    from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, join, dirname }               from "path";
import { fileURLToPath }                        from "url";
import { spawnSync }                            from "child_process";
import { homedir }                              from "os";

const __dirname       = dirname(fileURLToPath(import.meta.url))
const MONTAJ_ROOT     = resolve(__dirname, "..")
const PYTHON          = process.env.MONTAJ_PYTHON || "python3"
const PROJECT_DIR     = process.env.MONTAJ_PROJECT_DIR || process.cwd()
const CLI_TIMEOUT_MS  = 3_600_000   // 1 h — render can be long

// ---------------------------------------------------------------------------
// CLI tool scan — calls cli/mcp_schema.py to introspect argparse parsers
// ---------------------------------------------------------------------------

function scanCliTools() {
  const schemaScript = join(MONTAJ_ROOT, "cli", "mcp_schema.py")
  if (!existsSync(schemaScript)) {
    process.stderr.write(`[montaj-mcp] cli/mcp_schema.py not found at ${schemaScript}\n`)
    return []
  }

  const pythonPath = process.env.PYTHONPATH
    ? `${MONTAJ_ROOT}:${process.env.PYTHONPATH}`
    : MONTAJ_ROOT

  const result = spawnSync(PYTHON, [schemaScript], {
    encoding: "utf8",
    timeout:  15_000,
    env: { ...process.env, PYTHONPATH: pythonPath, MONTAJ_ROOT, MONTAJ_PROJECT_DIR: PROJECT_DIR },
  })

  if (result.status !== 0 || result.error) {
    process.stderr.write(`[montaj-mcp] cli tool scan failed:\n${result.stderr}\n`)
    return []
  }

  try {
    return JSON.parse(result.stdout)
  } catch (e) {
    process.stderr.write(`[montaj-mcp] cli tool scan returned invalid JSON: ${e.message}\n`)
    return []
  }
}

// ---------------------------------------------------------------------------
// CLI arg builder — maps MCP args object → CLI flag array
// ---------------------------------------------------------------------------

function buildCliArgs(tool, args) {
  const positionals = tool._positionals || []
  const cliArgs     = []

  // 1. Positional arguments in declared order
  for (const dest of positionals) {
    const val = args[dest]
    if (val === undefined || val === null) continue
    if (Array.isArray(val)) cliArgs.push(...val.map(String))
    else                    cliArgs.push(String(val))
  }

  // 2. Optional flags
  for (const [key, val] of Object.entries(args)) {
    if (positionals.includes(key))             continue
    if (val === undefined || val === null)      continue
    if (val === false)                         continue

    const flag = "--" + key.replace(/_/g, "-")

    if (val === true)         cliArgs.push(flag)
    else if (Array.isArray(val)) cliArgs.push(flag, ...val.map(String))
    else                      cliArgs.push(flag, String(val))
  }

  // 3. Structured output — only when the command supports --json
  if (tool._has_json) cliArgs.push("--json")

  return cliArgs
}

// ---------------------------------------------------------------------------
// Output wrapper — plain-text paths → JSON envelope for MCP callers
// ---------------------------------------------------------------------------

function wrapOutput(stdout) {
  const text = stdout.trim()
  if (!text)                                    return "{}"
  if (text.startsWith("{") || text.startsWith("[")) return text
  return JSON.stringify({ path: text })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cliTools = scanCliTools()

  process.stderr.write(
    `[montaj-mcp] loaded ${cliTools.length} tool(s) from CLI\n`
  )

  const server = new Server(
    { name: "montaj", version: "0.2.0" },
    { capabilities: { tools: {}, resources: {} } },
  )

  // ---------------------------------------------------------------------------
  // Profile resources — montaj://profile/<name>
  // ---------------------------------------------------------------------------

  function scanProfiles() {
    const profilesDir = join(homedir(), ".montaj", "profiles")
    if (!existsSync(profilesDir)) return []
    try {
      return readdirSync(profilesDir, { withFileTypes: true })
        .filter(e =>
          e.isDirectory() &&
          existsSync(join(profilesDir, e.name, "analysis_current.json"))
        )
        .map(e => e.name)
    } catch {
      return []
    }
  }

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: scanProfiles().map(name => ({
      uri:         `montaj://profile/${name}`,
      name:        `Profile: ${name}`,
      description: `Creator style profile for ${name} — pacing, colour palette, editorial direction`,
      mimeType:    "text/markdown",
    })),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    if (!uri.startsWith("montaj://profile/")) {
      return { contents: [{ uri, mimeType: "text/plain", text: `Unknown resource: ${uri}` }] }
    }
    const name      = uri.slice("montaj://profile/".length)
    const stylePath = join(homedir(), ".montaj", "profiles", name, "style_profile.md")
    if (!existsSync(stylePath)) {
      return { contents: [{ uri, mimeType: "text/plain", text: `Profile '${name}' not found.` }] }
    }
    return { contents: [{ uri, mimeType: "text/markdown", text: readFileSync(stylePath, "utf8") }] }
  })

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: cliTools.map(tool => ({
      name:        tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    const tool = cliTools.find(t => t.name === name)
    if (!tool) {
      return {
        content:  [{ type: "text", text: JSON.stringify({ error: "unknown_tool", message: `No tool: ${name}` }) }],
        isError:  true,
      }
    }

    const cliArgs = buildCliArgs(tool, args || {})

    const pythonPath = process.env.PYTHONPATH
      ? `${MONTAJ_ROOT}:${process.env.PYTHONPATH}`
      : MONTAJ_ROOT

    const result = spawnSync(
      PYTHON,
      ["-m", "cli.main", ...tool._cli_tokens, ...cliArgs],
      {
        encoding: "utf8",
        timeout:  CLI_TIMEOUT_MS,
        cwd:      PROJECT_DIR,
        env: { ...process.env, PYTHONPATH: pythonPath, MONTAJ_ROOT, MONTAJ_PROJECT_DIR: PROJECT_DIR },
      }
    )

    if (result.error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "spawn_error", message: result.error.message }) }],
        isError: true,
      }
    }

    if (result.signal === "SIGTERM") {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "timeout", message: `Tool '${name}' exceeded timeout` }) }],
        isError: true,
      }
    }

    if (result.status !== 0) {
      return {
        content: [{ type: "text", text: result.stderr?.trim() || `Tool '${name}' failed (exit ${result.status})` }],
        isError: true,
      }
    }

    return {
      content: [{ type: "text", text: wrapOutput(result.stdout || "") }],
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(err => {
  process.stderr.write(JSON.stringify({ error: "server_error", message: err.message }) + "\n")
  process.exit(1)
})
