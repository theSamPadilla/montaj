import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAudioTrackFilters } from '../mix-audio.js'

// buildAudioTrackFilters is the single place both the ducking and
// non-ducking branches build their `afade` filters — see mix-audio.js. Each
// branch gets its own coverage below since the fadeFilters string is built
// independently in each.

test('buildAudioTrackFilters: defaults to the exp curve when fadeInCurve/fadeOutCurve are absent', () => {
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 10, fadeIn: 1, fadeOut: 2 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.match(atrack, /afade=t=in:d=1:curve=exp/)
  assert.match(atrack, /afade=t=out:st=8:d=2:curve=exp/)
})

test('buildAudioTrackFilters: maps linear to ffmpeg\'s tri curve', () => {
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 10, fadeIn: 1, fadeOut: 2, fadeInCurve: 'linear', fadeOutCurve: 'linear' }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.match(atrack, /afade=t=in:d=1:curve=tri/)
  assert.match(atrack, /afade=t=out:st=8:d=2:curve=tri/)
})

test('buildAudioTrackFilters: passes log through unchanged, and each side maps independently', () => {
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 10, fadeIn: 1, fadeOut: 2, fadeInCurve: 'log', fadeOutCurve: 'exp' }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.match(atrack, /afade=t=in:d=1:curve=log/)
  assert.match(atrack, /afade=t=out:st=8:d=2:curve=exp/)
})

test('buildAudioTrackFilters: ducking branch applies the curve to its own afade filters too', () => {
  const track = {
    id: 't1', src: 'a.mp3', start: 0, end: 10, fadeIn: 1, fadeOut: 2,
    fadeInCurve: 'linear', fadeOutCurve: 'log',
    ducking: { enabled: true },
  }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const mscaled = filterParts.find(p => p.includes('mscaled0'))
  assert.match(mscaled, /afade=t=in:d=1:curve=tri/)
  assert.match(mscaled, /afade=t=out:st=8:d=2:curve=log/)
})

test('buildAudioTrackFilters: no afade filter at all when a side has no fade', () => {
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 10 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.doesNotMatch(atrack, /afade/)
})
