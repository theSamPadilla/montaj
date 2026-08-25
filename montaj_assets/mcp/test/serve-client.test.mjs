import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { readServeInfo, fetchContext } from "../serve-client.js"

function withLockfile(contents) {
  const dir = mkdtempSync(join(tmpdir(), "montaj-lock-"))
  const path = join(dir, "serve.json")
  if (contents !== null) writeFileSync(path, contents)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("readServeInfo returns null when the lockfile is absent", () => {
  const { path, cleanup } = withLockfile(null)
  assert.equal(readServeInfo(path), null)
  cleanup()
})

test("readServeInfo returns null on malformed json", () => {
  const { path, cleanup } = withLockfile("{not json")
  assert.equal(readServeInfo(path), null)
  cleanup()
})

test("readServeInfo returns null when the pid is dead", () => {
  const { path, cleanup } = withLockfile(JSON.stringify({ port: 3000, pid: 2 ** 22 }))
  assert.equal(readServeInfo(path), null)
  cleanup()
})

test("readServeInfo returns the info for a live pid", () => {
  const { path, cleanup } = withLockfile(JSON.stringify({ port: 3123, pid: process.pid }))
  const info = readServeInfo(path)
  assert.equal(info.port, 3123)
  cleanup()
})

test("fetchContext reports unavailable when there is no lockfile", async () => {
  const { path, cleanup } = withLockfile(null)
  const result = await fetchContext({ lockfilePath: path })
  assert.equal(result.ok, false)
  assert.match(result.reason, /not running/i)
  cleanup()
})

test("fetchContext reports unavailable when serve refuses the connection", async () => {
  // Port 1 is privileged and nothing listens there; the connection fails fast.
  const { path, cleanup } = withLockfile(JSON.stringify({ port: 1, pid: process.pid }))
  const result = await fetchContext({ lockfilePath: path })
  assert.equal(result.ok, false)
  assert.match(result.reason, /could not reach/i)
  cleanup()
})

test("fetchContext returns the parsed body on success", async () => {
  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ active: true, project: { id: "p1" } }))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const port = server.address().port
  const { path, cleanup } = withLockfile(JSON.stringify({ port, pid: process.pid }))

  const result = await fetchContext({ lockfilePath: path })
  assert.equal(result.ok, true)
  assert.equal(result.body.project.id, "p1")

  cleanup()
  await new Promise((r) => server.close(r))
})
