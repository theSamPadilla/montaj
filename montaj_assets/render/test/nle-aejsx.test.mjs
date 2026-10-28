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
import { writeAeScript, AE_SCRIPT_TEMPLATE } from '../nle/aejsx.js'
import { cleanFileName } from '../nle/file-name.js'
import { ExportError } from '../nle/export-error.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nle')
const PROJECT_DIR = resolve('/proj')
const PKG = '/out/Edit (After Effects)'
const PKG_DIR = PKG
const MARKER = '.montaj-editor-export'
const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))

const VIDEO = { exists: true, hasVideo: true, hasAudio: true, width: 1920, height: 1080, isStill: false }
const IMAGE = { ...VIDEO, hasAudio: false, width: 1000, height: 800, isStill: true }
const AUDIO = { ...VIDEO, hasVideo: false, width: null, height: null }

function make(name, project = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')), PKG = PKG_DIR) {
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

/** ExtendScript's File() decodes `%XX` runs on construction; a stray `%` stays. */
const decodeUri = (s) => String(s).replace(/(%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m) } catch { return m } })
const encodeUri = (p) => p.split('/').map((x) => encodeURIComponent(x)).join('/')

/**
 * A recording stand-in for the After Effects object model. Returns what the script did.
 *   saveThrows        proj.save throws
 *   missing           file names (endings) that do not exist
 *   existing          .aep endings that DO exist (by default none)
 *   openResult        what app.open returns (default: a project)
 *   newProjectNull    app.newProject returns null (the user cancelled its save prompt)
 *   importThrows      endings proj.importFile refuses
 *   addCompThrows     items.addComp throws
 *   noAudio           every layer has no audio (setting audioEnabled then throws, as After Effects does)
 *   fileName          what $.fileName is
 *   markerIn          folders that hold the package marker (default: the package)
 *   notFootage        endings ImportOptions.canImportAs(FOOTAGE) says no to
 *   aepParent         how the .aep File writes its parent folder (another form of the same folder, or another one)
 *   os                what $.os says
 */
function runMock(jsx, {
  saveThrows = false, missing = [], existing = [], openResult = {}, newProjectNull = false, importThrows = [],
  addCompThrows = false, noAudio = false, fileName = `${PKG}/Edit (After Effects).jsx`, markerIn = [PKG], notFootage = [],
  aepParent = null, os = 'Macintosh OS 14.5.0',
} = {}) {
  const log = {
    comps: [], layers: [], imports: [], importAs: [], items: [], alerts: [], saved: null, opened: null, text: [], folders: [],
    calls: { beginUndoGroup: 0, endUndoGroup: 0, beginSuppressDialogs: 0, endSuppressDialogs: 0, newProject: 0 },
  }
  const prop = (o = {}) => {
    const p = { keys: [], value: null, setValue(v) { p.value = v }, setValueAtTime(t, v) { p.keys.push([t, v]) }, ...o }
    return p
  }
  class MarkerValue { constructor(c) { this.comment = c } }
  class Shape {}
  class ImportOptions {
    constructor(f) { this.file = f; this.importAs = null }
    canImportAs(t) { return t === 'FOOTAGE' && !notFootage.some((m) => this.file.fsName.endsWith(m)) }
  }
  // ExtendScript's File() and Folder() work with or without `new`, and decode %XX.
  function Folder(path) {
    if (!(this instanceof Folder)) return new Folder(path)
    this.fsName = decodeUri(path)
    this.absoluteURI = encodeUri(this.fsName)
    log.folders.push(this.fsName)
  }
  Object.defineProperty(Folder.prototype, 'exists', { get() { return true } })
  function File(path) {
    if (!(this instanceof File)) return new File(path)
    const fs = decodeUri(path)
    this.fsName = fs
    this.absoluteURI = encodeUri(fs)
    const dir = fs.replace(/\/[^/]*$/, '')
    this.parent = new Folder(encodeUri(aepParent && fs.endsWith('.aep') ? aepParent(dir) : dir))
  }
  File.encode = (s) => encodeURIComponent(s)
  Object.defineProperty(File.prototype, 'exists', {
    get() {
      const f = this.fsName
      if (f.endsWith(`/${MARKER}`)) return markerIn.includes(f.slice(0, -MARKER.length - 1))
      if (f.endsWith('.aep')) return existing.some((m) => f.endsWith(m))
      return !missing.some((m) => f.endsWith(m))
    },
  })
  // A TextDocument: fill and stroke colours cannot be set while fill or stroke is off.
  const textDoc = () => {
    const d = { text: 'x', applyFill: false, applyStroke: false }
    const guarded = (name, flag) => {
      let v
      Object.defineProperty(d, name, {
        get: () => v,
        set: (x) => { if (!d[flag]) throw new Error(`${name} set while ${flag} is false`); v = x },
        enumerable: true,
      })
    }
    guarded('fillColor', 'applyFill'); guarded('strokeColor', 'applyStroke'); guarded('strokeWidth', 'applyStroke')
    return d
  }
  const makeLayer = (src, isText) => {
    const props = {}
    const get = (n) => (props[n] ??= prop())
    let audioEnabled = true
    const layer = {
      source: src, name: '', stretch: 100, startTime: 0, inPoint: 0, outPoint: 1e9, enabled: true,
      hasAudio: !noAudio && !isText && !!src && !src.still,
      get audioEnabled() { return audioEnabled },
      set audioEnabled(v) { if (!layer.hasAudio) throw new Error('no audio'); audioEnabled = v },
      markers: [], masks: [],
      property(n) {
        if (n === 'Transform') return { property: get }
        if (n === 'Marker') return { setValueAtTime(t, v) { layer.markers.push([t, v.comment]) } }
        if (n === 'Masks') return { addProperty() { const m = prop(); layer.masks.push(m); return { property: () => m } } }
        if (n === 'Audio') return { property: get }
        if (n === 'Source Text') return props['Source Text'] ??= prop({ value: textDoc() })
        return get(n)
      },
      props, isText,
    }
    log.layers.push(layer)
    return layer
  }
  const comp = {
    layers: { add: (item) => makeLayer(item, false), addText: (t) => { const l = makeLayer(null, true); l.text = t; log.text.push(t); return l } },
    openInViewer() {},
  }
  const proj = {
    items: { addComp(...a) { if (addCompThrows) throw new Error('addComp refused'); log.comps.push(a); return comp } },
    importFile(opt) {
      const path = opt.file.fsName
      if (importThrows.some((m) => path.endsWith(m))) throw new Error('unsupported file')
      log.imports.push(path)
      log.importAs.push(opt.importAs)
      const item = { path, still: /\.(png|jpe?g)$/i.test(path), mainSource: { alphaMode: null } }
      log.items.push(item)
      return item
    },
    save(f) { if (saveThrows) throw new Error('no'); log.saved = f.fsName },
  }
  const count = (n, fn) => (...a) => { log.calls[n]++; return fn?.(...a) }
  const ctx = {
    $: { fileName, os },
    app: {
      version: '24.0x1',
      newProject: count('newProject', () => (newProjectNull ? null : proj)),
      open: (f) => { log.opened = f.fsName; return openResult },
      beginUndoGroup: count('beginUndoGroup'), endUndoGroup: count('endUndoGroup'),
      beginSuppressDialogs: count('beginSuppressDialogs'), endSuppressDialogs: count('endSuppressDialogs'),
    },
    File, Folder, ImportOptions, MarkerValue, Shape,
    ImportAsType: { FOOTAGE: 'FOOTAGE', PROJECT: 'PROJECT', COMP: 'COMP', COMP_CROPPED_LAYERS: 'COMP_CROPPED_LAYERS' },
    AlphaMode: { STRAIGHT: 'STRAIGHT', PREMULTIPLIED: 'PREMULTIPLIED', IGNORE: 'IGNORE' },
    ParagraphJustification: { CENTER_JUSTIFY: 1 },
    alert: (m) => log.alerts.push(m),
    parseFloat, Math, String,
  }
  vm.createContext(ctx)
  vm.runInContext(jsx.replace(/^#target.*$/m, ''), ctx)
  return log
}

/** The undo group and the dialog suppression each close what they open. */
function assertBalanced(log) {
  assert.equal(log.calls.beginUndoGroup, log.calls.endUndoGroup, 'undo groups balanced')
  assert.equal(log.calls.beginSuppressDialogs, log.calls.endSuppressDialogs, 'dialog suppression balanced')
}

/** Arrays made inside the vm are of its realm; compare them as plain data. */
const plain = (v) => JSON.parse(JSON.stringify(v))
const dataOf = (jsx) => JSON.parse(jsx.match(/var DATA = ([\s\S]*?);\nvar HERE/)[1])
/** The script with its DATA edited, as a hand-edited (or forged) script would carry it. */
const withData = (jsx, edit) => {
  const d = dataOf(jsx)
  edit(d)
  return jsx.replace(/^var DATA = .*$/m, () => `var DATA = ${JSON.stringify(d)};`)
}
const layerOf = (log, clip) => log.layers.find((l) => l.name === clip || l.name === `Overlay ${clip}`)

/** A one-track project of video clips, for the cases the fixtures do not hold. */
const oneTrack = (items, settings = { resolution: [1920, 1080], fps: 30 }) => ({ id: 'one', status: 'final', settings, tracks: [{ id: 'trk-0', items }] })
const clip = (id, extra = {}) => ({ id, type: 'video', src: `/abs/${id}.mp4`, start: 0, end: 2, inPoint: 0, outPoint: 2, ...extra })

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
      assert.equal(log.calls.beginUndoGroup, 1)
      assertBalanced(log)
      assert.match(out.jsx, /^[\x00-\x7e]*$/, 'the script is ASCII')
      assert.ok(log.imports.length > 0)
      assert.ok(log.importAs.every((t) => t === 'FOOTAGE'), 'every import is forced to footage')
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

  test('media is written relative to the package; the package folder itself is the one absolute path', () => {
    const { out } = make('layers')
    const data = dataOf(out.jsx)
    assert.equal(data.dir, PKG)
    const { dir, ...rest } = data
    const text = JSON.stringify(rest)
    assert.ok(!text.includes('"/out/') && !text.includes('/proj/'), 'no other absolute path in the data')
    assert.ok(data.layers.every((l) => !l.path.startsWith('/')))
    assert.ok(data.layers.every((l) => l.path.startsWith(l.kind === 'graphic' ? 'graphics/' : 'media/')))
    assert.ok(dir)
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
    const data = dataOf(out.jsx)
    assert.ok(data.audio.length > 0)
    const l = log.layers.find((x) => x.name === data.audio[0].id)
    assert.ok(l)
  })

  test('muted clip sound is switched off', () => {
    const { out } = make('muted')
    const log = runMock(out.jsx)
    assert.ok(log.layers.some((l) => l.audioEnabled === false))
  })

  test('a muted clip whose layer has no sound is left alone (audioEnabled would throw)', () => {
    const { out } = make('muted')
    const log = runMock(out.jsx, { noAudio: true })
    assert.deepEqual(log.alerts, [])
    assert.ok(log.saved)
  })

  test('a refused save says why it failed and what may cause it, once', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { saveThrows: true })
    assert.equal(log.alerts.length, 1)
    assert.match(log.alerts[0], /could not be saved \(Error: no\)/)
    assert.match(log.alerts[0], /Allow Scripts to Write Files and Access Network .* may be off/)
    assertBalanced(log)
  })

  test('a missing media file is named, not fatal', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { missing: ['.mp4'] })
    assert.equal(log.alerts.length, 1)
    assert.match(log.alerts[0], /Not found beside this script/)
  })

  test('left-out features come back in leftOut and as ONE marker on their clip naming each', () => {
    let checked = 0
    for (const name of names) {
      const { tl, out } = make(name)
      const log = runMock(out.jsx)
      const videoIds = new Set(tl.videoTracks.flatMap((t) => t.clips).map((c) => c.id))
      for (const { clip: id, label } of out.leftOut) {
        if (!videoIds.has(id)) continue
        const l = layerOf(log, id)
        assert.ok(l, `${name}: ${id} is a layer`)
        assert.equal(l.markers.length, 1, `${name}: ${id} has one marker`)
        assert.ok(l.markers[0][1].includes(label), `${name}: ${id}'s marker names ${label}`)
        checked++
      }
    }
    assert.ok(checked >= 3, 'the fixtures leave something out')
  })

  test('a mask, a blend mode and an opacity curve warn once for the clip', () => {
    const { out } = make('cm', {
  id: 'cm', status: 'final', settings: { resolution: [1920, 1080], fps: 30 },
  tracks: [{ id: 'trk-0', items: [
    { id: 'm', type: 'video', src: '/abs/m.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2,
      mask: { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, blendMode: 'screen',
      keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }] },
  ] }],
})
    const w = out.warnings.filter((x) => /its mask, blend mode or opacity animation is not in the timeline/.test(x))
    assert.equal(w.length, 1, out.warnings.join(' | '))
    assert.match(w[0], /^m:/)
    assert.ok(out.leftOut.some((l) => l.clip === 'm' && l.label === 'Stays in Montaj: blend mode'))
  })

  test('two left-out features on one clip share one marker', () => {
    const { out } = make('two-marks', oneTrack([clip('a', { loop: true, remove_bg: true })]))
    const log = runMock(out.jsx)
    const a = layerOf(log, 'a')
    assert.deepEqual(a.markers, [[0, 'Stays in Montaj: loop; Stays in Montaj: background removal']])
    assert.equal(out.leftOut.length, 2)
  })

  test('the script is ASCII and every caption comes back as written', () => {
    const texts = ['line\u2028sep\u2029para', 'emoji \u{1F600} and caf\u00e9', 'quote " and back\\slash', 'not a comment */ end', 'del\u007f']
    const project = {
      ...oneTrack([clip('a')]),
      captions: { style: 'subtitle', segments: texts.map((text, i) => ({ id: `c${i}`, text, start: i * 0.3, end: i * 0.3 + 0.2 })) },
    }
    const { out } = make('unicode', project)
    assert.match(out.jsx, /^[\x00-\x7e]*$/)
    const log = runMock(out.jsx)
    assert.deepEqual(log.text, texts)
    assert.deepEqual(log.alerts, [])
  })

  test('a cancelled save prompt on the open project builds nothing', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { newProjectNull: true })
    assert.equal(log.alerts.length, 1)
    assert.match(log.alerts[0], /your open project was kept/)
    assert.equal(log.calls.beginUndoGroup, 0)
    assertBalanced(log)
    assert.equal(log.comps.length, 0)
    assert.equal(log.saved, null)
  })

  test('an error while building is one alert, the undo group closes and nothing is saved', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { addCompThrows: true })
    assert.equal(log.alerts.length, 1)
    assert.match(log.alerts[0], /^Montaj could not build the composition: Error: addComp refused.*Nothing was saved\.$/)
    assert.equal(log.calls.beginUndoGroup, 1)
    assertBalanced(log)
    assert.equal(log.saved, null)
  })

  test('a file that will not import is named at the end and the rest is built', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { importThrows: ['/a.mp4'] })
    assert.equal(log.alerts.length, 1)
    assert.match(log.alerts[0], /Could not import: media\/a\.mp4 \(Error: unsupported file\)/)
    assert.ok(!layerOf(log, 'a'))
    assert.ok(layerOf(log, 'b') && layerOf(log, 'c') && layerOf(log, 'd'))
    assertBalanced(log)
    assert.ok(log.saved)
  })

  test('a file After Effects cannot import as footage is not imported, and is named at the end', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { notFootage: ['/b.mp4'] })
    assert.ok(!log.imports.some((p) => p.endsWith('/b.mp4')))
    assert.ok(!layerOf(log, 'b'))
    assert.ok(layerOf(log, 'a'))
    assert.equal(log.alerts.length, 1)
    assert.match(log.alerts[0], /Could not import: media\/b\.mp4\./)
    assertBalanced(log)
  })

  test('a project, script or preset file as a source is left out, with one warning each', () => {
    const exts = ['aep', 'AEPX', 'aet', 'prproj', 'jsx', 'JsxBin', 'jsxinc', 'ffx', 'mogrt']
    const items = exts.map((e, i) => clip(`p${i}`, { src: `/abs/proj${i}.${e}`, start: i, end: i + 1 }))
    items.push(clip('ok', { start: 10, end: 12 }), clip('again', { src: '/abs/proj0.aep', start: 12, end: 13 }))
    const project = { ...oneTrack(items), audio: { tracks: [{ id: 'm', src: '/abs/score.PRPROJ', start: 0, end: 5 }, { id: 'w', src: '/abs/w.wav', start: 0, end: 5 }] } }
    const { out } = make('project-files', project)
    const data = dataOf(out.jsx)
    assert.deepEqual(data.layers.map((l) => l.id), ['ok'])
    assert.deepEqual(data.audio.map((a) => a.id), ['w'])
    const warned = out.warnings.filter((w) => /is a project, script or preset file, not media/.test(w))
    assert.equal(warned.length, exts.length + 1, 'one warning per file (proj0.aep twice is one)')
    for (let i = 0; i < exts.length; i++) assert.ok(warned.some((w) => w.startsWith(`proj${i}.${exts[i]} `)), exts[i])
    assert.ok(warned.some((w) => w.startsWith('score.PRPROJ ')))
    const log = runMock(out.jsx)
    assert.ok(log.imports.every((p) => !/\.(aepx?|aet|prproj|jsx(bin|inc)?|ffx|mogrt)$/i.test(p)), log.imports.join(' '))
  })

  test('a trailing dot or space, or a dotfile, does not hide a project or script file', () => {
    const tricky = ['x.aep.', 'x.aep..', 'x.aep ', '.jsx']
    const project = oneTrack([...tricky.map((n, i) => clip(`t${i}`, { src: `/abs/${n}`, start: i, end: i + 1 })), clip('ok', { start: 5, end: 6 })])
    const { out } = make('tricky', project)
    assert.deepEqual(dataOf(out.jsx).layers.map((l) => l.id), ['ok'])
    assert.equal(out.warnings.filter((w) => /not media/.test(w)).length, tricky.length)
  })

  test('a clip left out as not media is not in leftOut either', () => {
    const project = oneTrack([clip('p', { src: '/abs/x.aep', loop: true, remove_bg: true }), clip('k', { start: 2, end: 4, loop: true })])
    const { out } = make('skipped-left-out', project)
    assert.deepEqual(out.leftOut.map((l) => l.clip), ['k'])
    assert.deepEqual(dataOf(out.jsx).layers.map((l) => l.id), ['k'])
  })

  test('an overlay is never taken for a script file (its src is its .jsx component)', () => {
    const { tl, out } = make('keyframes')
    const graphicsIds = tl.videoTracks.flatMap((t) => t.clips).filter((c) => c.kind === 'graphic').map((c) => c.id)
    assert.ok(graphicsIds.length > 0)
    for (const id of graphicsIds) assert.ok(dataOf(out.jsx).layers.some((l) => l.id === id), id)
    assert.deepEqual(out.warnings.filter((w) => /not media/.test(w)), [])
  })

  test('a missing file shared by several clips is named once', () => {
    const { out } = make('shared', oneTrack([clip('a', { src: '/abs/same.mp4' }), clip('b', { src: '/abs/same.mp4', start: 2, end: 4 })]))
    const log = runMock(out.jsx, { missing: ['same.mp4'] })
    assert.equal(log.alerts.length, 1)
    assert.equal(log.alerts[0].match(/same\.mp4/g).length, 1)
  })

  test('an .aep already beside the script is opened, never rebuilt or saved over', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { existing: ['/Edit (After Effects).aep'] })
    assert.equal(log.opened, `${PKG}/Edit (After Effects).aep`)
    assert.equal(log.calls.newProject, 0)
    assert.equal(log.comps.length, 0)
    assert.equal(log.saved, null)
    assert.deepEqual(log.alerts, [])
    assertBalanced(log)
    const refused = runMock(out.jsx, { existing: ['/Edit (After Effects).aep'], openResult: null })
    assert.equal(refused.alerts.length, 1)
    assert.match(refused.alerts[0], /is already beside this script; open it from File > Open/)
    assert.equal(refused.saved, null)
  })

  test('a %XX in a file name stays itself (File() decodes, the script encodes each segment)', () => {
    const { out } = make('percent', oneTrack([clip('a', { src: '/abs/a%20b.mp4' })]))
    const log = runMock(out.jsx)
    assert.deepEqual(log.imports, [`${PKG}/media/a%20b.mp4`])
    assert.deepEqual(log.alerts, [])
  })

  test('run from the package: its own folder holds the marker, so everything resolves beside it', () => {
    const { out } = make('hard-cut')
    // DATA.dir is a stale path that holds no marker: the script's own folder wins.
    const moved = withData(out.jsx, (d) => { d.dir = '/gone/away' })
    assert.equal(dataOf(moved).dir, '/gone/away')
    const log = runMock(moved, { markerIn: [PKG] })
    assert.ok(log.imports.length > 0 && log.imports.every((p) => p.startsWith(`${PKG}/media/`)))
    assert.equal(log.saved, `${PKG}/Edit (After Effects).aep`)
    assert.deepEqual(log.alerts, [])
  })

  test('a copy run from elsewhere: the package folder written into it (DATA.dir) holds the marker', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { fileName: '/private/app/run/abc123.jsx', markerIn: [PKG] })
    assert.ok(log.imports.length > 0 && log.imports.every((p) => p.startsWith(`${PKG}/media/`)), log.imports.join(' '))
    assert.equal(log.saved, `${PKG}/Edit (After Effects).aep`)
    assert.deepEqual(log.alerts, [])
  })

  test('a copy run from elsewhere finds an .aep already in the package and opens it', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { fileName: '/private/app/run/abc123.jsx', existing: ['/Edit (After Effects).aep'] })
    assert.equal(log.opened, `${PKG}/Edit (After Effects).aep`)
    assert.equal(log.calls.newProject, 0)
  })

  test('neither the script\'s folder nor DATA.dir holds the marker: one alert, nothing built', () => {
    const { out } = make('hard-cut')
    const log = runMock(out.jsx, { fileName: '/private/app/run/abc123.jsx', markerIn: [] })
    assert.deepEqual(log.alerts, ["Montaj: this script's package folder is missing; open it from the package folder."])
    assert.equal(log.calls.newProject, 0)
    assert.equal(log.calls.beginUndoGroup, 0)
    assert.equal(log.saved, null)
    assert.equal(log.opened, null)
  })

  test('DATA.dir keeps a %XX and non-ASCII in the package name, and stays ASCII in the script', () => {
    const pkg = '/out/caf\u00e9 100%25 (After Effects)'
    const { out } = make('hard-cut', undefined, pkg)
    assert.match(out.jsx, /^[\x00-\x7e]*$/)
    assert.equal(dataOf(out.jsx).dir, pkg)
    const log = runMock(out.jsx, { fileName: '/private/app/run/abc123.jsx', markerIn: [pkg] })
    assert.ok(log.imports.length > 0 && log.imports.every((p) => p.startsWith(`${pkg}/media/`)), log.imports.join(' '))
    assert.equal(log.saved, `${pkg}/Edit (After Effects).aep`)
  })

  test('a Windows package folder is read in the /c/... form File and Folder take', () => {
    const tl = make('hard-cut').tl
    const jsx = writeAeScript(tl, {}, { name: 'W', pkgDir: 'C:\\Users\\me\\W (After Effects)' }).jsx
    assert.equal(dataOf(jsx).dir, 'C:\\Users\\me\\W (After Effects)')
    const log = runMock(jsx, { fileName: '/private/app/run/abc123.jsx', markerIn: ['/c/Users/me/W (After Effects)'] })
    assert.deepEqual(log.alerts.filter((a) => /package folder is missing/.test(a)), [])
    assert.equal(log.saved, '/c/Users/me/W (After Effects)/W.aep')
  })

  test('a crop is a mask measured from the layer\'s top left', () => {
    const { tl, out } = make('layers')
    const log = runMock(out.jsx)
    const data = dataOf(out.jsx)
    let checked = 0
    for (const L of data.layers.filter((x) => x.crop)) {
      const [w, h] = L.mediaSize
      const { left, right, top, bottom } = L.crop
      const x0 = (left / 100) * w, x1 = w - (right / 100) * w, y0 = (top / 100) * h, y1 = h - (bottom / 100) * h
      const v = plain(layerOf(log, L.id).masks[0].value.vertices)
      assert.deepEqual(v, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
      assert.ok(v.flat().every((n) => n >= 0), 'inside the layer, not about its centre')
      checked++
    }
    assert.ok(checked >= 2 && tl)
    const logo = plain(layerOf(log, 'logo').masks[0].value.vertices)
    assert.deepEqual(logo, [[250, 200], [750, 200], [750, 600], [250, 600]])
  })

  test('caption text turns fill and stroke on before their colours', () => {
    const { out } = make('captions')
    const log = runMock(out.jsx)
    const cap = log.layers.find((l) => l.isText)
    const doc = cap.props['Source Text'].value
    assert.deepEqual(plain([doc.applyFill, doc.applyStroke, doc.fillColor, doc.strokeColor]), [true, true, [1, 1, 1], [0, 0, 0]])
    assert.deepEqual(log.alerts, [])
  })

  test('overlay and caption movies are read as straight alpha; footage is left as After Effects guesses', () => {
    const { out } = make('captions')
    const log = runMock(out.jsx)
    const movies = log.items.filter((i) => /\/graphics\/|captions\.mov$/.test(i.path))
    assert.ok(movies.length >= 1)
    for (const m of movies) assert.equal(m.mainSource.alphaMode, 'STRAIGHT', m.path)
    for (const m of log.items.filter((i) => i.path.includes('/media/'))) assert.equal(m.mainSource.alphaMode, null, m.path)
  })

  test('a crossfade crosses the two clips\' sound too, so it does not double', () => {
    const { tl, out } = make('crossfade')
    const log = runMock(out.jsx)
    const t = tl.videoTracks.flatMap((x) => x.transitions)[0]
    const [s, e] = [t.startFrame / tl.fps, t.endFrame / tl.fps]
    const a = plain(layerOf(log, t.fromClipId).props['Audio Levels'].keys)
    const b = plain(layerOf(log, t.toClipId).props['Audio Levels'].keys)
    assert.deepEqual(a, [[s, [0, 0]], [e, [-96, -96]]])
    assert.deepEqual(b, [[s, [-96, -96]], [e, [0, 0]]])
  })
})

describe('aejsx: nothing in the data can become code or move the save', () => {
  const HOSTILE = ['\n#include x', '//@include y', '#target aftereffects', '*/', 'a\u2028b', '#includepath "/tmp"', '#script evil', '\r\n//@include z']
  const segments = HOSTILE.map((text, i) => ({ id: `c${i}`, text, start: i * 0.4, end: i * 0.4 + 0.3 }))
  const tl = make('hostile', oneTrack([clip('a', { id: '#include clip' }), clip('//@include', { start: 2, end: 4 })])).tl
  const write = (name, pkgDir) => writeAeScript(tl, {}, { name, pkgDir, captionSegments: segments })
  const tplLines = AE_SCRIPT_TEMPLATE.split('\n')
  const dataIndex = tplLines.indexOf('var DATA = /*DATA*/;')

  test('every line is a template line, but the one DATA line, which has no # and no //', () => {
    assert.ok(dataIndex > 0)
    for (const name of [...HOSTILE, 'Edit (After Effects)']) {
      const { jsx } = write(name, `/out/${cleanFileName(name)} (After Effects)`)
      const lines = jsx.split('\n')
      assert.equal(lines.length, tplLines.length, JSON.stringify(name))
      lines.forEach((line, i) => {
        if (i === dataIndex) {
          assert.match(line, /^var DATA = \{.*\};$/)
          assert.ok(!line.includes('#') && !line.includes('//'), `${JSON.stringify(name)}: the DATA line has no # or //`)
        } else {
          assert.equal(line, tplLines[i], `${JSON.stringify(name)}: line ${i + 1} is the template's`)
        }
      })
      assert.match(jsx, /^[\x00-\x7e]*$/)
      // Nothing is lost: the data parses back to what was written.
      const d = dataOf(jsx)
      assert.equal(d.name, name)
      assert.deepEqual(d.captions.map((c) => c.text), HOSTILE)
    }
  })

  test('the hostile text still runs and comes back as written', () => {
    const name = '\n#include x'
    const pkg = `/out/${cleanFileName(name)} (After Effects)`
    const { jsx } = write(name, pkg)
    const log = runMock(jsx, { fileName: `${pkg}/x.jsx`, markerIn: [pkg] })
    assert.deepEqual(log.text, HOSTILE)
    assert.equal(log.comps[0][0], name)
    assert.equal(log.saved, `${pkg}/${cleanFileName(name)}.aep`)
  })

  test('hostile media file names and a hostile package folder keep the same invariants and come back as written', () => {
    const pkg = '/out/#x //@include   "q" (After Effects)'
    const files = { '/abs/a.mp4': '#include a.mp4', '/abs//@include b.mov': '//@include b.mov', '/abs/c.mp4': 'line sep.mp4', '/abs/m.wav': '#music "x".wav' }
    const project = {
      ...oneTrack([
        clip('a'), clip('b', { src: '/abs//@include b.mov', start: 2, end: 4 }), clip('c', { start: 4, end: 6 }),
      ]),
      audio: { tracks: [{ id: 'm', src: '/abs/m.wav', start: 0, end: 6 }] },
    }
    project.tracks.push({ id: 'trk-1', items: [{ id: 'g', type: 'overlay', src: '/abs/g.jsx', start: 0, end: 2 }] })
    const { tl } = make('hostile-files', project)
    const mediaPaths = Object.fromEntries(Object.keys(tl.sources).filter((p) => files[p]).map((p) => [p, `${pkg}/media/${files[p]}`]))
    const { jsx, warnings } = writeAeScript(tl, {}, {
      name: 'Edit', pkgDir: pkg, mediaPaths,
      graphics: { g: `${pkg}/graphics/#include g .mov` },
      captions: `${pkg}/#captions //@include .mov`,
      captionSegments: [{ text: 'hi', start: 0, end: 1 }],
    })
    assert.deepEqual(warnings.filter((w) => /not media/.test(w)), [])

    const lines = jsx.split('\n')
    assert.equal(lines.length, tplLines.length)
    lines.forEach((line, i) => {
      if (i === dataIndex) assert.ok(/^var DATA = \{.*\};$/.test(line) && !line.includes('#') && !line.includes('//'), 'the DATA line')
      else assert.equal(line, tplLines[i], `line ${i + 1}`)
    })
    assert.match(jsx, /^[\x00-\x7e]*$/)

    const d = dataOf(jsx)
    assert.equal(d.dir, pkg)
    assert.deepEqual(d.layers.map((l) => l.path), ['media/#include a.mp4', 'media/@include b.mov', 'media/line sep.mp4', 'graphics/#include g .mov'])
    assert.deepEqual(d.audio.map((x) => x.path), ['media/#music "x".wav'])
    // A media path is relative to the package (path.relative collapses its //); dir is written as given, // and all.
    assert.equal(d.captionsMovie, '#captions /@include .mov')

    // Run from the package and as a copy elsewhere: every file comes in under its own name, in the package.
    const want = [...d.layers.map((l) => l.path), ...d.audio.map((x) => x.path), d.captionsMovie].map((r) => `${pkg}/${r}`).sort()
    for (const fileName of [`${pkg}/Edit.jsx`, '/private/app/run/abc.jsx']) {
      const log = runMock(jsx, { fileName, markerIn: [pkg] })
      assert.deepEqual(log.alerts, [], fileName)
      assert.deepEqual([...log.imports].sort(), want, fileName)
      assert.equal(log.saved, `${pkg}/Edit.aep`)
    }
  })

  test('the template loads no code; its one directive is the fixed #target line', () => {
    for (const bad of ['$.evalFile', 'eval(', 'Function(', '#include', '//@include', '#script', '#includepath']) {
      assert.ok(!AE_SCRIPT_TEMPLATE.includes(bad), bad)
    }
    const directives = tplLines.filter((l) => /^\s*(#|\/\/@)/.test(l))
    assert.deepEqual(directives, ['#target aftereffects'])
  })

  test('the save target is always <package folder>/<cleaned name>.aep', () => {
    for (const name of [...HOSTILE, '../up', 'a/b', 'a\\b', '..', '.', 'ok']) {
      const pkg = '/out/pkg (After Effects)'
      const { jsx, aep } = write(name, pkg)
      const want = `${pkg}/${cleanFileName(name)}.aep`
      assert.equal(aep, want, JSON.stringify(name))
      for (const fileName of [`${pkg}/x.jsx`, '/private/app/run/abc.jsx']) {
        const log = runMock(jsx, { fileName, markerIn: [pkg] })
        assert.equal(log.saved, want, JSON.stringify(name))
      }
    }
  })

  test('the save check compares folders however After Effects writes them', () => {
    const { jsx } = write('ok', PKG)
    const passes = [
      ['a trailing slash', { aepParent: (d) => `${d}/` }],
      ['Windows: another case', { os: 'Windows/64 10.0', aepParent: (d) => d.toUpperCase() }],
      ['Windows: backslashes and a trailing one', { os: 'Windows/64 10.0', aepParent: (d) => `${d.replace(/\//g, '\\')}\\` }],
    ]
    for (const [what, opts] of passes) {
      const log = runMock(jsx, { markerIn: [PKG], ...opts })
      assert.deepEqual(log.alerts, [], what)
      assert.ok(log.saved, what)
    }
    const refuses = [
      ['another folder', { aepParent: () => '/elsewhere' }],
      ['a folder inside the package', { aepParent: (d) => `${d}/sub` }],
      ['the parent folder', { aepParent: (d) => d.replace(/\/[^/]*$/, '') }],
      ['macOS: another case is another folder', { aepParent: (d) => d.toUpperCase() }],
      ['Windows: another folder', { os: 'Windows/64 10.0', aepParent: () => 'C:\\elsewhere' }],
    ]
    for (const [what, opts] of refuses) {
      const log = runMock(jsx, { markerIn: [PKG], ...opts })
      assert.equal(log.saved, null, what)
      assert.equal(log.calls.newProject, 0, what)
      assert.match(log.alerts[0] ?? '', /outside its package folder/, what)
    }
  })

  test('a script whose DATA aims the save elsewhere refuses and builds nothing', () => {
    const { jsx } = write('ok', PKG)
    for (const aep of ['../evil.aep', 'sub/evil.aep', 'sub\\evil.aep', '/abs/evil.aep']) {
      const forged = withData(jsx, (d) => { d.aep = aep })
      const log = runMock(forged, { markerIn: [PKG] })
      assert.equal(log.saved, null, aep)
      assert.equal(log.opened, null, aep)
      assert.equal(log.calls.newProject, 0, aep)
      assert.equal(log.alerts.length, 1, aep)
      assert.match(log.alerts[0], /outside its package folder/)
    }
  })
})

describe('aejsx: what After Effects can take', () => {
  const tlOf = (name) => make(name).tl
  const write = (tl) => writeAeScript(tl, {}, { name: 'X', pkgDir: PKG })
  const rejects = (tl, re) => assert.throws(() => write(tl), (e) => e instanceof ExportError && e.code === 'invalid_project' && re.test(e.message))

  test('a size, length or rate outside addComp\'s ranges is invalid_project', () => {
    rejects({ ...tlOf('hard-cut'), width: 3 }, /width must be a whole number of pixels from 4 to 30000/)
    rejects({ ...tlOf('hard-cut'), height: 30001 }, /height/)
    rejects({ ...tlOf('hard-cut'), width: 1920.5 }, /width/)
    rejects({ ...tlOf('hard-cut'), fps: 120 }, /frame rate must be from 1 to 99/)
    rejects({ ...tlOf('hard-cut'), fps: 0.5 }, /frame rate/)
    const long = tlOf('hard-cut')
    rejects({ ...long, durationFrames: 10801 * long.fps }, /at most 10800 seconds/)
  })

  test('a number that is not finite anywhere in the data is invalid_project', () => {
    const tl = structuredClone(tlOf('hard-cut'))
    tl.videoTracks[0].clips[0].volume = NaN
    rejects(tl, /volume is not a number/)
    const t2 = structuredClone(tlOf('hard-cut'))
    t2.videoTracks[0].clips[0].speed = Infinity
    rejects(t2, /not a number/)
  })

  test('the edges of the ranges are fine', () => {
    const tl = tlOf('hard-cut')
    assert.doesNotThrow(() => write({ ...tl, width: 4, height: 30000, fps: 99 }))
    assert.doesNotThrow(() => write({ ...tl, fps: 1, durationFrames: 10800 }))
  })
})
