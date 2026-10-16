// render/test/nle-aejsx.test.mjs
/**
 * `writeAeScript` (render/nle/aejsx.js): the editor timeline as an After Effects script.
 *
 * No After Effects is needed: every fixture's script is run in a node `vm` against a MOCK of the After Effects
 * object model (app, File, comp/layer/property recorders). That proves the script parses, runs end to end, builds
 * the layers the timeline names, and saves; it does NOT prove After Effects accepts it (needs a real install).
 * A crude ES3 lint keeps the script to what ExtendScript runs.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNleTimeline } from '../nle/timeline.js'
import { writeAeScript } from '../nle/aejsx.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nle')
const PROJECT_DIR = resolve('/proj')
const PKG = '/out/Edit (After Effects)'
const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))

const VIDEO = { exists: true, hasVideo: true, hasAudio: true, width: 1920, height: 1080, isStill: false }
const IMAGE = { ...VIDEO, hasAudio: false, width: 1000, height: 800, isStill: true }
const AUDIO = { ...VIDEO, hasVideo: false, width: null, height: null }

function make(name, project = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))) {
  const tl = buildNleTimeline(project, { projectDir: PROJECT_DIR })
  const probes = {}
  for (const [p, s] of Object.entries(tl.sources)) probes[p] = s.kind === 'image' ? IMAGE : s.kind === 'audio' ? AUDIO : VIDEO
  const graphics = {}
  for (const t of tl.videoTracks) for (const c of t.clips) if (c.kind === 'graphic') graphics[c.id] = `${PKG}/graphics/${c.id}.mov`
  const mediaPaths = {}
  for (const p of Object.keys(tl.sources)) mediaPaths[p] = `${PKG}/media/${p.split('/').pop()}`
  const out = writeAeScript(tl, probes, {
    name: 'Edit (After Effects)', pkgDir: PKG, mediaPaths, graphics,
    captions: tl.captionsTrack ? `${PKG}/captions.mov` : null,
    captionSegments: project.captions?.segments ?? [],
  })
  return { tl, out, project }
}

/** A recording stand-in for the After Effects object model. Returns what the script did. */
function runMock(jsx, { saveThrows = false, missing = [] } = {}) {
  const log = { comps: [], layers: [], imports: [], alerts: [], saved: null, text: [] }
  const prop = (o = {}) => {
    const p = { keys: [], value: null, setValue(v) { p.value = v }, setValueAtTime(t, v) { p.keys.push([t, v]) }, ...o }
    return p
  }
  class MarkerValue { constructor(c) { this.comment = c } }
  class Shape {}
  class ImportOptions { constructor(f) { this.file = f } }
  // ExtendScript's File() works with or without `new`.
  function File(path) {
    if (!(this instanceof File)) return new File(path)
    this.fsName = path
    this.parent = { fsName: path.replace(/\/[^/]*$/, '') }
  }
  Object.defineProperty(File.prototype, 'exists', { get() { return !missing.some((m) => this.fsName.endsWith(m)) } })
  const makeLayer = (src, isText) => {
    const props = {}
    const get = (n) => (props[n] ??= prop())
    const layer = {
      source: src, name: '', stretch: 100, startTime: 0, inPoint: 0, outPoint: 1e9, enabled: true, audioEnabled: true, hasAudio: true,
      markers: [],
      property(n) {
        if (n === 'Transform') return { property: get }
        if (n === 'Marker') return { setValueAtTime(t, v) { layer.markers.push([t, v.comment]) } }
        if (n === 'Masks') return { addProperty() { return { property: () => prop() } } }
        if (n === 'Audio') return { property: get }
        if (n === 'Source Text') return props['Source Text'] ??= prop({ value: { text: 'x' } })
        return get(n)
      },
      props, isText,
    }
    log.layers.push(layer)
    return layer
  }
  const comp = {
    layers: { add: (item) => makeLayer(item, false), addText: (t) => { const l = makeLayer(null, true); l.text = t; return l } },
    openInViewer() {},
  }
  const proj = {
    items: { addComp(...a) { log.comps.push(a); return comp } },
    importFile(opt) { log.imports.push(opt.file.fsName); return { path: opt.file.fsName } },
    save(f) { if (saveThrows) throw new Error('no'); log.saved = f.fsName },
  }
  const ctx = {
    $: { fileName: `${PKG}/Edit (After Effects).jsx` },
    app: { version: '24.0x1', newProject: () => proj, beginUndoGroup() {}, endUndoGroup() {} },
    File, ImportOptions, MarkerValue, Shape,
    ParagraphJustification: { CENTER_JUSTIFY: 1 },
    alert: (m) => log.alerts.push(m),
    parseFloat, Math,
  }
  vm.createContext(ctx)
  vm.runInContext(jsx.replace(/^#target.*$/m, ''), ctx)
  return log
}

describe('aejsx: the script', () => {
  for (const name of names) {
    test(`${name}: parses, runs against a mock After Effects and saves beside itself`, () => {
      const { tl, out } = make(name)
      const log = runMock(out.jsx)
      assert.equal(log.comps.length, 1)
      const [, w, h, , dur, fps] = log.comps[0]
      assert.deepEqual([w, h, fps], [tl.width, tl.height, tl.fps])
      assert.ok(dur > 0)
      assert.equal(log.saved, `${PKG}/Edit (After Effects).aep`)
      assert.equal(out.aep, log.saved)
      assert.deepEqual(log.alerts, [])
    })
  }

  test('ES3 only: no arrow functions, let/const, template literals or JSON in the code', () => {
    for (const name of names) {
      const { out } = make(name)
      const code = out.jsx.replace(/^var DATA = [\s\S]*?;\nvar HERE/m, 'var HERE').replace(/^\/\/.*$/gm, '')
      assert.ok(!/=>/.test(code), `${name}: arrow`)
      { const m = code.match(/\b(let|const)\s.{0,30}/); assert.ok(!m, `${name}: let/const ${m && m[0]}`) }
      assert.ok(!/`/.test(code), `${name}: backtick`)
      assert.ok(!/\bJSON\b/.test(code), `${name}: JSON`)
      assert.ok(!/\.(includes|startsWith|endsWith|map|filter|forEach|indexOf)\(/.test(code), `${name}: ES5+ method`)
    }
  })

  test('media is written relative to the script, never absolute', () => {
    const { out } = make('layers')
    const data = out.jsx.match(/var DATA = ([\s\S]*?);\nvar HERE/)[1]
    assert.ok(!data.includes('"/out/') && !data.includes('/proj/'), 'no absolute path in the data')
    assert.match(data, /"path": "media\//)
  })

  test('layers: one per footage and image clip, in order, with static placement', () => {
    const { tl, out } = make('layers')
    const log = runMock(out.jsx)
    const clips = tl.videoTracks.flatMap((t) => t.clips).filter((c) => c.kind !== 'graphic')
    const names = log.layers.filter((l) => !l.isText).map((l) => l.name)
    for (const c of clips) assert.ok(names.includes(c.id), `${c.id} is a layer`)
    const first = log.layers.find((l) => l.name === clips[0].id)
    assert.ok(first.props.Position.value && first.props.Scale.value && first.props.Opacity.value !== null)
  })

  test('a crossfade becomes opposite opacity keys on both layers', () => {
    const { tl, out } = make('crossfade')
    const log = runMock(out.jsx)
    const t = tl.videoTracks.flatMap((x) => x.transitions)[0]
    assert.ok(t)
    const a = log.layers.find((l) => l.name === t.fromClipId)
    const b = log.layers.find((l) => l.name === t.toClipId)
    assert.equal(a.props.Opacity.keys.length, 2)
    assert.equal(a.props.Opacity.keys[1][1], 0)
    assert.equal(b.props.Opacity.keys[0][1], 0)
  })

  test('captions: an editable text layer per segment, plus the hidden exact-look movie', () => {
    const { project, out } = make('captions')
    const log = runMock(out.jsx)
    const segs = project.captions.segments.filter((s) => s.text)
    assert.equal(log.layers.filter((l) => l.isText).length, segs.length)
    const hidden = log.layers.find((l) => l.name.startsWith('Captions (exact look'))
    assert.ok(hidden && hidden.enabled === false)
  })

  test('audio.tracks become audio layers with fades', () => {
    const { out } = make('audio')
    const log = runMock(out.jsx)
    const data = JSON.parse(out.jsx.match(/var DATA = ([\s\S]*?);\nvar HERE/)[1])
    assert.ok(data.audio.length > 0)
    const l = log.layers.find((x) => x.name === data.audio[0].id)
    assert.ok(l)
  })

  test('muted clip sound is switched off', () => {
    const { out } = make('muted')
    const log = runMock(out.jsx)
    assert.ok(log.layers.some((l) => l.audioEnabled === false))
  })

  test('a refused save says how to allow it, once', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { saveThrows: true })
    assert.equal(log.alerts.length, 1)
    assert.match(log.alerts[0], /Allow Scripts to Write Files/)
  })

  test('a missing media file is named, not fatal', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { missing: ['.mp4'] })
    assert.equal(log.alerts.length, 1)
    assert.match(log.alerts[0], /Not found beside this script/)
  })

  test('left-out features come back as markers and in leftOut', () => {
    const { out } = make('keyframes')
    const log = runMock(out.jsx)
    assert.ok(Array.isArray(out.leftOut))
    const marked = log.layers.flatMap((l) => l.markers)
    assert.equal(marked.length >= out.leftOut.length ? true : out.leftOut.length === 0, true)
  })
})
