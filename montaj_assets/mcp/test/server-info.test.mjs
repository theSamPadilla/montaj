import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildServerInfo } from "../server.js"

// Minimal valid 1x1 red PNG (72 bytes) — real image bytes, not a stub.
const ONE_PIXEL_PNG_HEX =
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de" +
  "0000000c4944415478da6360f8cfc0c0c0040000060005f0dc4ee40000000049454e44ae426082"

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "montaj-mcp-icon-test-"))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("serverInfo defaults to title 'Montaj' with no env set", () => {
  const info = buildServerInfo({})
  assert.equal(info.name, "montaj")
  assert.equal(info.title, "Montaj")
  assert.equal(info.icons, undefined)
})

test("MONTAJ_MCP_SERVER_TITLE overrides the default title", () => {
  const info = buildServerInfo({ MONTAJ_MCP_SERVER_TITLE: "Montaj Desktop" })
  assert.equal(info.title, "Montaj Desktop")
})

test("icons are present and data-URI encoded when the env points at a real PNG", () => {
  withTempDir(dir => {
    const iconPath = join(dir, "icon.png")
    writeFileSync(iconPath, Buffer.from(ONE_PIXEL_PNG_HEX, "hex"))

    const info = buildServerInfo({ MONTAJ_MCP_ICON_PATH: iconPath })

    assert.ok(Array.isArray(info.icons), "icons should be an array")
    assert.equal(info.icons.length, 1)
    const [icon] = info.icons
    assert.equal(icon.mimeType, "image/png")
    assert.match(icon.src, /^data:image\/png;base64,/)
    assert.deepEqual(icon.sizes, ["256x256"])

    const base64 = icon.src.slice("data:image/png;base64,".length)
    assert.equal(Buffer.from(base64, "base64").toString("hex"), ONE_PIXEL_PNG_HEX)
  })
})

test("icons are present for a real SVG with sizes ['any']", () => {
  withTempDir(dir => {
    const iconPath = join(dir, "icon.svg")
    writeFileSync(iconPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')

    const info = buildServerInfo({ MONTAJ_MCP_ICON_PATH: iconPath })

    assert.equal(info.icons.length, 1)
    assert.equal(info.icons[0].mimeType, "image/svg+xml")
    assert.deepEqual(info.icons[0].sizes, ["any"])
  })
})

test("icons are absent, with a stderr note, when the file is missing", () => {
  const missingPath = join(tmpdir(), "montaj-mcp-icon-test-does-not-exist", "icon.png")
  const originalWrite = process.stderr.write
  let stderrOutput = ""
  process.stderr.write = chunk => { stderrOutput += chunk; return true }
  try {
    const info = buildServerInfo({ MONTAJ_MCP_ICON_PATH: missingPath })
    assert.equal(info.icons, undefined)
  } finally {
    process.stderr.write = originalWrite
  }
  assert.match(stderrOutput, /MONTAJ_MCP_ICON_PATH/)
})

test("icons are absent, with a stderr note, when the file is oversized", () => {
  withTempDir(dir => {
    const iconPath = join(dir, "big.png")
    writeFileSync(iconPath, Buffer.alloc(256 * 1024 + 1, 0))

    const originalWrite = process.stderr.write
    let stderrOutput = ""
    process.stderr.write = chunk => { stderrOutput += chunk; return true }
    let info
    try {
      info = buildServerInfo({ MONTAJ_MCP_ICON_PATH: iconPath })
    } finally {
      process.stderr.write = originalWrite
    }
    assert.equal(info.icons, undefined)
    assert.match(stderrOutput, /exceeds/)
  })
})

test("icons are absent, with a stderr note, for an unsupported extension", () => {
  withTempDir(dir => {
    const iconPath = join(dir, "icon.gif")
    writeFileSync(iconPath, Buffer.from(ONE_PIXEL_PNG_HEX, "hex"))

    const originalWrite = process.stderr.write
    let stderrOutput = ""
    process.stderr.write = chunk => { stderrOutput += chunk; return true }
    let info
    try {
      info = buildServerInfo({ MONTAJ_MCP_ICON_PATH: iconPath })
    } finally {
      process.stderr.write = originalWrite
    }
    assert.equal(info.icons, undefined)
    assert.match(stderrOutput, /\.png or \.svg/)
  })
})
