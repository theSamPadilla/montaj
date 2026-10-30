// render/test/nle-fcpxml.test.mjs
/** `writeFcpxml` (render/nle/fcpxml.js): every NLE fixture through it, well-formed, with the structure Final Cut reads. */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildNleTimeline } from '../nle/timeline.js'
import { writeFcpxml } from '../nle/fcpxml.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nle')
const PROJECT_DIR = resolve('/proj')
const XMLLINT = '/usr/bin/xmllint'
const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
const VIDEO = { exists: true, hasVideo: true, hasAudio: true, width: 1920, height: 1080, durationSeconds: 60, audioChannels: 2, audioSampleRate: 48000 }
const IMAGE = { ...VIDEO, hasAudio: false, width: 1000, height: 800, durationSeconds: null }
const AUDIO = { ...VIDEO, hasVideo: false, width: null, height: null, durationSeconds: 120 }

function make(name, project = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))) {
  const tl = buildNleTimeline(project, { projectDir: PROJECT_DIR })
  const probes = {}
  for (const [p, s] of Object.entries(tl.sources)) probes[p] = s.kind === 'image' ? IMAGE : s.kind === 'audio' ? AUDIO : VIDEO
  const graphics = {}
  for (const tr of tl.videoTracks) for (const c of tr.clips) if (c.kind === 'graphic') { graphics[c.id] = `/pkg/graphics/${c.id}.mov`; probes[graphics[c.id]] = VIDEO }
  const captions = tl.captionsTrack ? '/pkg/captions.mov' : null
  if (captions) probes[captions] = VIDEO
  return { tl, out: writeFcpxml(tl, probes, { name: 'Edit', graphics, captions }) }
}

describe('fcpxml', () => {
  for (const name of names) {
    test(`${name}: well-formed, every clip names a declared asset`, () => {
      const { out } = make(name)
      if (spawnSyncOk()) {
        const d = mkdtempSync(join(tmpdir(), 'fcpxml-'))
        try {
          writeFileSync(join(d, 'a.fcpxml'), out.xml)
          const r = spawnSync(XMLLINT, ['--noout', join(d, 'a.fcpxml')], { encoding: 'utf8' })
          assert.equal(r.status, 0, r.stderr)
        } finally { rmSync(d, { recursive: true, force: true }) }
      }
      const declared = new Set([...out.xml.matchAll(/<asset id="([^"]+)"/g)].map((m) => m[1]))
      for (const m of out.xml.matchAll(/<asset-clip ref="([^"]+)"/g)) assert.ok(declared.has(m[1]), `${m[1]} declared`)
      assert.match(out.xml, /<fcpxml version="1.9">/)
    })
  }

  test('speed becomes a timeMap; opacity, crossfade and mute are written', () => {
    assert.match(make('speed').out.xml, /<timeMap>/)
    assert.match(make('crossfade').out.xml, /<keyframeAnimation>/)
    assert.match(make('muted').out.xml, /<adjust-volume amount="-96dB"\/>/)
  })

  test('a control character in a clip id or a file name is dropped, so the XML stays well-formed', () => {
    const project = {
      id: 'ctl', status: 'final', settings: { resolution: [1920, 1080], fps: 30 },
      tracks: [{ id: 'trk-0', items: [
        { id: 'a\u0001b\u001f"<&>', type: 'video', src: '/abs/bell\u0007.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2, loop: true },
      ] }],
    }
    const tl = buildNleTimeline(project, { projectDir: PROJECT_DIR })
    const probes = Object.fromEntries(Object.keys(tl.sources).map((p) => [p, VIDEO]))
    const { xml } = writeFcpxml(tl, probes, { name: 'Edit\u0002' })
    assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml), 'no control character left')
    assert.match(xml, /name="ab&quot;&lt;&amp;&gt;"/)
    assert.match(xml, /<event name="Edit">/)
    if (spawnSyncOk()) {
      const r = spawnSync(XMLLINT, ['--noout', '-'], { input: xml, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
  })

  test('captions movie rides the top lane', () => {
    const { out } = make('captions')
    assert.match(out.xml, /name="Captions"/)
  })
})

describe('fcpxml: composite settings left out', () => {
  test('a mask, a blend mode and an opacity curve warn once for the clip', () => {
    const { out } = make('cm', {
  id: 'cm', status: 'final', settings: { resolution: [1920, 1080], fps: 30 },
  tracks: [{ id: 'trk-0', items: [
    { id: 'm', type: 'video', src: '/abs/m.mp4', start: 0, end: 2, inPoint: 0, outPoint: 2,
      mask: { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, blendMode: 'screen', blur: 30,
      keyframes: [{ prop: 'opacity', points: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }] },
    { id: 'b', type: 'video', src: '/abs/b.mp4', start: 2, end: 4, inPoint: 0, outPoint: 2, blur: 30 },
  ] }],
})
    const bw = out.warnings.filter((x) => /^b: its mask, blend mode, blur or opacity animation/.test(x))
    assert.equal(bw.length, 1, out.warnings.join(' | '))
    assert.ok(out.leftOut.some((l) => l.clip === 'b' && l.label === 'Stays in Montaj: blur'))
    const w = out.warnings.filter((x) => /^m: its mask, blend mode, blur or opacity animation is not in the timeline/.test(x))
    assert.equal(w.length, 1, out.warnings.join(' | '))
    assert.match(w[0], /^m:/)
    assert.ok(out.leftOut.some((l) => l.clip === 'm' && l.label === 'Stays in Montaj: mask'))
  })
})

function spawnSyncOk() { return spawnSync(XMLLINT, ['--version']).status === 0 }
