import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAudioTrackFilters } from '../mix-audio.js'

// buildAudioTrackFilters is the single place both the ducking and
// non-ducking branches build their `afade` filters — see mix-audio.js. They
// now share one `buildFadeFilters` helper rather than holding byte-identical
// copies, but each branch keeps its own coverage below: the helper is shared
// today, and these tests are what catches it being re-inlined or one branch
// being wired up wrong.
//
// Every test in the CURVE group below uses `start: 0`. That is a deliberate
// limitation of the group, not an oversight — and it is also why the
// stream-time bug in the STREAM TIME group further down survived for so long.

test('buildAudioTrackFilters: defaults to the exp curve when fadeInCurve/fadeOutCurve are absent', () => {
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 10, fadeIn: 1, fadeOut: 2 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.match(atrack, /afade=t=in:st=0:d=1:curve=exp/)
  assert.match(atrack, /afade=t=out:st=8:d=2:curve=exp/)
})

test('buildAudioTrackFilters: maps linear to ffmpeg\'s tri curve', () => {
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 10, fadeIn: 1, fadeOut: 2, fadeInCurve: 'linear', fadeOutCurve: 'linear' }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.match(atrack, /afade=t=in:st=0:d=1:curve=tri/)
  assert.match(atrack, /afade=t=out:st=8:d=2:curve=tri/)
})

test('buildAudioTrackFilters: passes log through unchanged, and each side maps independently', () => {
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 10, fadeIn: 1, fadeOut: 2, fadeInCurve: 'log', fadeOutCurve: 'exp' }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.match(atrack, /afade=t=in:st=0:d=1:curve=log/)
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
  assert.match(mscaled, /afade=t=in:st=0:d=1:curve=tri/)
  assert.match(mscaled, /afade=t=out:st=8:d=2:curve=log/)
})

test('buildAudioTrackFilters: no afade filter at all when a side has no fade', () => {
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 10 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.doesNotMatch(atrack, /afade/)
})

// ── STREAM TIME ─────────────────────────────────────────────────────────────
//
// `adelay` prepends `track.start` seconds of silence, so every filter chained
// after it is timed against the PADDED stream, not the track's own audio. Both
// `st=` values are therefore absolute timeline positions.
//
// The curve group above is the reason this needed its own group: every one of
// those cases uses `start: 0`, where the correct `end - fadeOut` and the broken
// `(end - start) - fadeOut` are numerically identical. They asserted `st=8` only
// to pin the curve NAME and would have gone on passing forever with the
// fade-out timed against the wrong clock. A `start > 0` fixture is the whole
// point of everything below — see mix-audio.js's `buildFadeFilters` for the
// silent-export failure this shipped.

test('buildAudioTrackFilters: fade-out on an offset track is timed to its timeline END, not its duration', () => {
  const track = { id: 't1', src: 'a.mp3', start: 5, end: 15, fadeOut: 2 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  // end - fadeOut = 13, so the fade lands on 13..15 — the track's real last 2s.
  assert.match(atrack, /afade=t=out:st=13:d=2:curve=exp/)
  // The bug: (end - start) - fadeOut = 8, which completes at stream time 10 —
  // 5s BEFORE this track's audio begins. afade=t=out then holds zero for the
  // rest of the stream, silencing the track's entire audible length.
  assert.doesNotMatch(atrack, /afade=t=out:st=8:/)
})

test('buildAudioTrackFilters: ducking branch times its fade-out in stream time too', () => {
  // Same fixture, ducking on. The faded bed is sidechaincompress's MAIN input
  // (the speech split is the detection key and is unaffected), so a mistimed
  // fade silences a ducked bed exactly as it silences a plain one — the point
  // of this test is that the shared helper reaches BOTH branches.
  const track = { id: 't1', src: 'a.mp3', start: 5, end: 15, fadeOut: 2, ducking: { enabled: true } }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const mscaled = filterParts.find(p => p.includes('mscaled0'))
  assert.match(mscaled, /afade=t=out:st=13:d=2:curve=exp/)
  assert.doesNotMatch(mscaled, /afade=t=out:st=8:/)
})

test('buildAudioTrackFilters: fade-in on an offset track starts when the track does, not inside the adelay padding', () => {
  const track = { id: 't1', src: 'a.mp3', start: 5, end: 15, fadeIn: 1 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  // Carrying no st= at all, this ran at stream time 0..1 — entirely within the
  // 5s of silence adelay prepends — so the track jumped in at full volume.
  assert.match(atrack, /afade=t=in:st=5:d=1:curve=exp/)
})

test('buildAudioTrackFilters: an offset track fades on the real values that shipped silent', () => {
  // The V4 Release music bed, verbatim — the values that actually shipped
  // silent. Pre-fix this emitted st=23.05, reaching zero gain at 26.13s, 1.5s
  // before the track's own audio began at 27.67s. Full account: mix-audio.js's
  // `buildFadeFilters` and KNOWN-DIVERGENCES D2.
  const track = { id: 'bed2', src: 'b.mp3', start: 27.67, end: 53.80, volume: 0.9, fadeIn: 0.3, fadeOut: 3.08 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.match(atrack, /adelay=27670:/)
  assert.match(atrack, /afade=t=in:st=27\.67:d=0\.3:/)
  assert.match(atrack, /afade=t=out:st=50\.72:d=3\.08:/)
  // The fade-out must begin AFTER the audio starts, or the track is silenced.
  const st = Number(atrack.match(/afade=t=out:st=([\d.]+):/)[1])
  assert.ok(st > 27.67, `fade-out st=${st} must fall after the track starts at 27.67`)
})

test('buildAudioTrackFilters: a track at the origin is behaviourally unchanged', () => {
  // Guards the fix against altering what already worked. Asserts BEHAVIOUR, not
  // the literal string: making st= explicit turns `afade=t=in:d=1` into
  // `afade=t=in:st=0:d=1`, and st=0 is afade's own default. That equivalence is
  // measured, not assumed — mixing this exact fixture through mixAudioIntoVideo
  // before and after the change and decoding to raw PCM gives byte-identical
  // output (sha256 014ab3916dad500302c577374cb550c51e2755c1acb84acfa0efe09cf7e99ac9,
  // 1920000 bytes, both sides).
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 10, fadeIn: 1, fadeOut: 2 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  // At start:0 the corrected `end - fadeOut` and the old `(end - start) - fadeOut`
  // agree, so this value is genuinely untouched by the fix.
  assert.match(atrack, /afade=t=out:st=8:d=2:curve=exp/)
  assert.match(atrack, /afade=t=in:st=0:d=1:curve=exp/)
})

test('buildAudioTrackFilters: a track with no `end` gets NO fade-out rather than one at st=0', () => {
  // `end` is optional by design — engine/validate.py's `_validate_audio_tracks`
  // deliberately does not require it, because mix-audio.js never trims on `end`
  // (the source window is inPoint/outPoint alone), so a bed without one plays its
  // natural length. Defaulting a missing `end` to 0 put the fade-out at st=0,
  // inside the adelay padding, and afade=t=out then holds zero for the rest of the
  // stream — silencing the whole track. Reachable just by dragging a fade-out grip
  // on an end-less bed, which commits `{ fadeOut }` and nothing else.
  const track = { id: 't1', src: 'a.mp3', start: 12, fadeOut: 2 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  const atrack = filterParts.find(p => p.includes('atrack0'))
  assert.doesNotMatch(atrack, /afade=t=out/)
  assert.match(atrack, /adelay=12000:/)   // still positioned; only the fade is dropped
})

test('buildAudioTrackFilters: a zero-width window counts as undeclared, not as end=0', () => {
  // `start: 0, end: 0` exists on disk. Treating it as a real end silenced the track
  // the same way; the editor's resolveAudioWindow treats it as undeclared too.
  const track = { id: 't1', src: 'a.mp3', start: 0, end: 0, fadeOut: 2 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  assert.doesNotMatch(filterParts.find(p => p.includes('atrack0')), /afade=t=out/)
})

test('buildAudioTrackFilters: a fade-in is still emitted on a track with no `end`', () => {
  // Only the fade-OUT needs an end to anchor to; the fade-in anchors to `start`.
  const track = { id: 't1', src: 'a.mp3', start: 12, fadeIn: 1 }
  const { filterParts } = buildAudioTrackFilters([track], 1, '[0:a]')
  assert.match(filterParts.find(p => p.includes('atrack0')), /afade=t=in:st=12:d=1:curve=exp/)
})
