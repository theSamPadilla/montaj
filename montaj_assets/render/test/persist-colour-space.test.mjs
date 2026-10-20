// montaj_assets/render/test/persist-colour-space.test.mjs
//
// The render's colour-space write-back (persist-colour-space.js, §472): atomic,
// re-reads right before writing, writes only while colorSpace is unset, never
// fails the render. S472_IMPL=<module path> swaps in another implementation
// (used to run the same tests against the old inline logic).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const IMPL = process.env.S472_IMPL ? pathToFileURL(process.env.S472_IMPL).href : new URL('../persist-colour-space.js', import.meta.url).href
const { persistColorSpace } = await import(IMPL)

const WORK = mkdtempSync(join(tmpdir(), 'montaj-persist-colour-'))
after(() => { try { chmodSync(WORK, 0o755) } catch {} rmSync(WORK, { recursive: true, force: true }) })
let n = 0
function folder() { const d = join(WORK, `p${n++}`); mkdirSync(d); return d }
const files = (d) => readdirSync(d).sort()
const baseProject = () => ({ version: '0.1', settings: { resolution: [1080, 1920], fps: 30 }, tracks: [[{ id: 'a', src: 'a.mp4' }]] })
const noTemps = (d) => assert.deepEqual(files(d), ['project.json'])

test('(a) writes the colour when unset; complete JSON, no temp left', () => {
  const d = folder(), p = join(d, 'project.json')
  writeFileSync(p, JSON.stringify(baseProject(), null, 2))
  const r = persistColorSpace(p, 'hlg', { log: () => {} })
  assert.equal(r.written, true)
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).settings.colorSpace, 'hlg')
  noTemps(d)
})

test('(a) the write goes through a temp named project.json.<pid>.<hex>.tmp renamed over the file', () => {
  const d = folder(), p = join(d, 'project.json')
  writeFileSync(p, JSON.stringify(baseProject()))
  const seen = []
  persistColorSpace(p, 'hlg', { log: () => {}, fsImpl: {
    writeFileSync: (f, t) => { seen.push(['write', f]); writeFileSync(f, t) },
    renameSync: (a, b) => { seen.push(['rename', a, b]); renameSync(a, b) },
  } })
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0][1], p, 'must not write project.json in place')
  assert.match(seen[0][1].slice(d.length + 1), /^project\.json\.\d+\.[0-9a-f]+\.tmp$/)
  assert.deepEqual(seen[1], ['rename', seen[0][1], p])
})

test('(b) writes nothing when the fresh copy already has a colorSpace', () => {
  const d = folder(), p = join(d, 'project.json')
  const doc = baseProject(); doc.settings.colorSpace = 'sdr'
  const text = JSON.stringify(doc, null, 2)
  writeFileSync(p, text)
  const r = persistColorSpace(p, 'hlg', { log: () => {} })
  assert.equal(r.written, false)
  assert.equal(readFileSync(p, 'utf8'), text)
  noTemps(d)
})

test('(c) keeps a field a concurrent writer changed after detection', () => {
  const d = folder(), p = join(d, 'project.json')
  writeFileSync(p, JSON.stringify(baseProject(), null, 2))
  const stale = baseProject() // what the render read first
  const fresh = baseProject(); fresh.tracks[0].push({ id: 'b', src: 'b.mp4' }); fresh.settings.fps = 60
  writeFileSync(p, JSON.stringify(fresh, null, 2)) // concurrent writer lands
  persistColorSpace(p, 'hlg', { log: () => {} })
  const out = JSON.parse(readFileSync(p, 'utf8'))
  assert.equal(out.tracks[0].length, 2)
  assert.equal(out.settings.fps, 60)
  assert.equal(out.settings.colorSpace, 'hlg')
  assert.notDeepEqual(out.tracks, stale.tracks)
})

test('(d) a reader polling while the write runs never sees a partial file', async () => {
  const d = folder(), p = join(d, 'project.json')
  const doc = baseProject()
  doc.blob = Array.from({ length: 40000 }, (_, i) => ({ i, pad: 'x'.repeat(100) })) // about 5 MB
  const unset = JSON.stringify(doc, null, 2)
  writeFileSync(p, unset)
  const child = join(d, '..', `writer${n}.mjs`)
  writeFileSync(child, `
    import { writeFileSync, renameSync } from 'node:fs'
    const { persistColorSpace } = await import(${JSON.stringify(IMPL)})
    const p = ${JSON.stringify(p)}, unset = ${JSON.stringify(unset)}
    for (let i = 0; i < 25; i++) {
      // reset to unset atomically so only the impl under test can truncate
      const t = p + '.reset'; writeFileSync(t, unset); renameSync(t, p)
      persistColorSpace(p, 'hlg', { log: () => {} })
    }
  `)
  let done = false, reads = 0, bad = 0
  const proc = spawn(process.execPath, [child], { stdio: 'inherit' })
  const exited = new Promise((res) => proc.on('exit', () => { done = true; res() }))
  while (!done) {
    try { JSON.parse(readFileSync(p, 'utf8')); reads++ } catch (e) { if (e.code !== 'ENOENT') bad++ }
    await new Promise((r) => setImmediate(r))
  }
  await exited
  assert.ok(reads > 20, `only ${reads} reads`)
  assert.equal(bad, 0, `${bad} of ${reads + bad} reads saw a cut-off file`)
})

test('(e) read-only folder: no throw, no temp left, a log line', () => {
  const d = folder(), p = join(d, 'project.json')
  const text = JSON.stringify(baseProject(), null, 2)
  writeFileSync(p, text)
  const logs = []
  const eacces = Object.assign(new Error('denied'), { code: 'EACCES' })
  const r = persistColorSpace(p, 'hlg', { log: (m) => logs.push(m), fsImpl: { writeFileSync: () => { throw eacces } } })
  assert.equal(r.written, false)
  assert.equal(logs.length, 1)
  assert.equal(readFileSync(p, 'utf8'), text)
  noTemps(d)
})

test('(e) a failing rename: no throw, temp removed, a log line', () => {
  const d = folder(), p = join(d, 'project.json')
  const text = JSON.stringify(baseProject(), null, 2)
  writeFileSync(p, text)
  const logs = []
  const r = persistColorSpace(p, 'hlg', { log: (m) => logs.push(m), fsImpl: { renameSync: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }) } } })
  assert.equal(r.written, false)
  assert.equal(logs.length, 1)
  assert.equal(readFileSync(p, 'utf8'), text)
  noTemps(d)
})

test('(f) output differs from the old inline text only by the colorSpace key', () => {
  const d = folder(), p = join(d, 'project.json')
  const doc = baseProject(); doc.name = 'é ü'
  writeFileSync(p, JSON.stringify(doc, null, 2))
  const old = JSON.parse(readFileSync(p, 'utf8'))
  old.settings = { ...(old.settings ?? {}), colorSpace: 'hlg' }
  const expected = JSON.stringify(old, null, 2)
  persistColorSpace(p, 'hlg', { log: () => {} })
  assert.equal(readFileSync(p, 'utf8'), expected)
})
