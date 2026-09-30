import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import { buildCliArgs } from "../server.js"

const MCP_DIR     = dirname(fileURLToPath(import.meta.url))
const MONTAJ_ROOT = join(MCP_DIR, "..", "..", "..")

// An argparse option's dest can deliberately differ from its flag string
// (e.g. cli/commands/init.py's `--clip` with dest="clips"). The schema's
// _flags map (cli/mcp_schema.py) is how buildCliArgs learns the real flag;
// falling back to deriving "--clips" from the property name is exactly the
// regression this file guards against.

function tool(overrides = {}) {
  return {
    _positionals: [],
    _flags: {},
    _has_json: false,
    ...overrides,
  }
}

test("uses the schema's recorded flag when dest differs from the CLI flag", () => {
  const t = tool({ _flags: { clips: "--clip" } })
  const args = buildCliArgs(t, { clips: ["a.mp4"] })
  assert.deepEqual(args, ["--clip", "a.mp4"])
})

test("falls back to deriving the flag from the key when no _flags entry exists", () => {
  const t = tool({ _flags: {} })
  const args = buildCliArgs(t, { color_space: "auto" })
  assert.deepEqual(args, ["--color-space", "auto"])
})

test("positionals are unaffected by _flags and still come first", () => {
  const t = tool({ _positionals: ["path"], _flags: { verbose: "-v" } })
  const args = buildCliArgs(t, { path: "clip.mp4", verbose: true })
  assert.deepEqual(args, ["clip.mp4", "-v"])
})

test("boolean true just appends the mapped flag, no value", () => {
  const t = tool({ _flags: { no_proxy: "--no-proxy" } })
  const args = buildCliArgs(t, { no_proxy: true })
  assert.deepEqual(args, ["--no-proxy"])
})

// `init` is no longer an MCP tool (PL11), but it is the command with the most
// flag/dest mismatches, so its schema is built here the way cli/mcp_schema.py
// builds every exported tool.
const INIT_SCHEMA = [
  "import argparse, json",
  "from cli.main import register_command",
  "from cli.mcp_schema import _collect",
  "p = argparse.ArgumentParser(prog='montaj')",
  "s = p.add_subparsers(dest='command')",
  "register_command('init', s)",
  "out = []",
  "_collect(['init'], s.choices['init'], out)",
  "print(json.dumps(out))",
].join("\n")

test("end-to-end: the real 'init' command's schema round-trips 'clips' to --clip, not --clips", () => {
  const stdout = execFileSync("python3", ["-c", INIT_SCHEMA], {
    cwd: MONTAJ_ROOT,
    encoding: "utf8",
  })
  const tools = JSON.parse(stdout)
  const initTool = tools.find(t => t.name === "init")
  assert.ok(initTool, "expected an 'init' tool from _collect")

  const args = buildCliArgs(initTool, { prompt: "test", clips: ["a.mp4"] })
  assert.ok(args.includes("--clip"), `expected --clip in ${JSON.stringify(args)}`)
  assert.ok(!args.includes("--clips"), `did not expect --clips in ${JSON.stringify(args)}`)
})
