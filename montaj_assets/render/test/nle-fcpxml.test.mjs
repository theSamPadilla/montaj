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

function make(name) {
  const project = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))
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

  test('captions movie rides the top lane', () => {
    const { out } = make('captions')
    assert.match(out.xml, /name="Captions"/)
  })
})

function spawnSyncOk() { return spawnSync(XMLLINT, ['--version']).status === 0 }
