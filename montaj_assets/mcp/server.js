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
import { readFileSync, existsSync, readdirSync, realpathSync } from "fs";
import { resolve, join, dirname }               from "path";
import { fileURLToPath, pathToFileURL }         from "url";
import { spawnSync }                            from "child_process";
import { homedir }                              from "os";
import { runCli }                               from "./run-cli.js";
import { fetchContext }                         from "./serve-client.js";

const __dirname       = dirname(fileURLToPath(import.meta.url))
// MCP_DIR  = where this server.js lives (montaj_assets/mcp/) — for sibling files like node_modules.
// MONTAJ_ROOT = the Python project root (where cli/, steps/ live) — set by cli/commands/mcp.py.
// Fallback for direct `node server.js` invocation: jump two levels up from montaj_assets/mcp/.
const MCP_DIR         = __dirname
const MONTAJ_ROOT     = process.env.MONTAJ_ROOT || resolve(__dirname, "..", "..")
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
// Editor context resource — montaj://context
// ---------------------------------------------------------------------------

export const CONTEXT_URI = "montaj://context"

/**
 * Turn a serve-client result into the text an agent reads.
 *
 * Markdown, not JSON, and deliberately so: this is read by a language model,
 * and every failure mode has to be a sentence it can act on. A raw JSON dump
 * with `"clipAtPlayhead": null` invites a confident wrong answer; "the playhead
 * is over a gap" does not.
 */
export function renderContextResource(result) {
  if (!result.ok) {
    return `# Editor context — unavailable\n\n${result.reason}.\n\n` +
           `Start the editor with \`montaj serve\` and open a project, then read this resource again.`
  }
  const body = result.body
  if (!body.active) {
    return `# Editor context — no editor open\n\n` +
           `${body.reason ?? "No editor has reported recently"}.\n\n` +
           `Nothing is on screen right now, so there is no "here" to resolve against. ` +
           `Ask the user which project and timestamp they mean, or read the project directly.`
  }

  const p    = body.project ?? {}
  const head = body.playhead ?? {}
  const clip = body.clipAtPlayhead
  const cap  = body.transcriptAroundPlayhead
  const lines = [
    `# Editor context`,
    ``,
    `**Project:** ${p.name ?? "(unnamed)"} (\`${p.id}\`)${
      typeof p.durationSec === "number" ? ` — ${p.durationSec.toFixed(2)}s` : ""}`,
    `**Playhead:** ${head.sec}s (frame ${head.frame})`,
    `**Reported:** ${body.ageMs} ms ago`,
    ``,
  ]

  lines.push(`## Clip under the playhead`, ``)
  if (clip) {
    lines.push(
      `- id: \`${clip.id}\`  ·  type: ${clip.type ?? "video"}`,
      `- source: \`${clip.src}\``,
      `- timeline window: ${clip.start}s → ${clip.end}s`,
      clip.sourceTimeSec !== null && clip.sourceTimeSec !== undefined
        ? `- position within the source file: ${clip.sourceTimeSec}s`
        : `- (this item carries no inPoint, so source time is unmapped)`,
      ``,
    )
  } else {
    lines.push(`The playhead is over a gap — no item is on screen at this time.`, ``)
  }

  lines.push(`## Selection`, ``)
  if (body.selection?.length) {
    for (const s of body.selection) {
      lines.push(`- \`${s.id}\` (${s.kind}${s.src ? `, \`${s.src}\`` : ""})`)
    }
  } else {
    lines.push(`Nothing is selected.`)
  }
  if (body.selectedCaptionId) {
    lines.push(`Caption segment \`${body.selectedCaptionId}\` is selected.`)
  }
  lines.push(``)

  lines.push(`## What is being said here`, ``)
  if (cap) {
    lines.push(`> ${String(cap.text).replace(/\s+/g, " ").trim()}`, ``)
    if (typeof cap.startSec === "number" && typeof cap.endSec === "number") {
      lines.push(`That quote spans ${cap.startSec}s → ${cap.endSec}s and may run wider than the playhead: it is the segment under the playhead plus one either side.`, ``)
    }
    if (cap.segmentIdAtPlayhead) {
      lines.push(`The playhead sits inside caption segment \`${cap.segmentIdAtPlayhead}\`.`)
    } else {
      lines.push(`The playhead falls between caption segments.`)
    }
  } else {
    lines.push(`This project has no captions, so there is no transcript to quote.`)
  }

  return lines.join("\n")
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
    resources: [
      {
        uri:         CONTEXT_URI,
        name:        "Editor context",
        description: "What the montaj editor is looking at right now — playhead, " +
                     "selection, the clip under the playhead, and the words being said there",
        mimeType:    "text/markdown",
      },
      ...scanProfiles().map(name => ({
        uri:         `montaj://profile/${name}`,
        name:        `Profile: ${name}`,
        description: `Creator style profile for ${name} — pacing, colour palette, editorial direction`,
        mimeType:    "text/markdown",
      })),
    ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params
    if (uri === CONTEXT_URI) {
      return {
        contents: [{
          uri,
          mimeType: "text/markdown",
          text: renderContextResource(await fetchContext()),
        }],
      }
    }
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

    const result = await runCli(
      PYTHON,
      ["-m", "cli.main", ...tool._cli_tokens, ...cliArgs],
      {
        timeoutMs: CLI_TIMEOUT_MS,
        cwd:       PROJECT_DIR,
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

// Only start the server when this file is the entry point. Importing it — as
// the tests do, to reach renderContextResource — must not connect a stdio
// transport, which would hold stdin open and hang the test runner.
// realpathSync is load-bearing: import.meta.url is always the resolved real
// path, so comparing it against a raw argv[1] fails whenever server.js is
// reached through a symlink (an npm bin shim, a symlinked $HOME), and the
// server would exit 0 having done nothing.
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) &&
           import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main().catch(err => {
    process.stderr.write(JSON.stringify({ error: "server_error", message: err.message }) + "\n")
    process.exit(1)
  })
}
