import { test } from "node:test"
import assert from "node:assert/strict"

import { CONTEXT_URI, renderContextResource } from "../server.js"

test("the context uri is stable", () => {
  assert.equal(CONTEXT_URI, "montaj://context")
})

test("an unreachable serve renders as a readable sentence, not an error", () => {
  const text = renderContextResource({ ok: false, reason: "montaj serve is not running" })
  assert.match(text, /not running/)
  assert.doesNotMatch(text, /undefined|\[object Object\]/)
})

test("no active editor renders as a plain statement", () => {
  const text = renderContextResource({
    ok: true,
    body: { active: false, reason: "no editor has reported recently" },
  })
  assert.match(text, /no editor/i)
  assert.doesNotMatch(text, /playhead/i)
})

test("an active editor renders the project, playhead and clip", () => {
  const text = renderContextResource({
    ok: true,
    body: {
      active: true,
      project: { id: "p1", name: "robotics-ban", durationSec: 20 },
      playhead: { sec: 12.4, frame: 372 },
      clipAtPlayhead: { id: "c2", src: "B.MOV", start: 10, end: 20, sourceTimeSec: 2.4 },
      selection: [{ id: "c2", kind: "video" }],
      transcriptAroundPlayhead: { text: "the thing nobody tells you", segmentIdAtPlayhead: "s2" },
      ageMs: 340,
    },
  })
  assert.match(text, /robotics-ban/)
  assert.match(text, /12\.4/)
  assert.match(text, /B\.MOV/)
  assert.match(text, /the thing nobody tells you/)
  assert.match(text, /340\s*ms/)
})

test("an active editor with no captions says so rather than printing null", () => {
  const text = renderContextResource({
    ok: true,
    body: {
      active: true,
      project: { id: "p1", name: "x", durationSec: 5 },
      playhead: { sec: 1, frame: 30 },
      clipAtPlayhead: null,
      selection: [],
      transcriptAroundPlayhead: null,
      ageMs: 10,
    },
  })
  assert.doesNotMatch(text, /null/)
  assert.match(text, /no captions/i)
})
