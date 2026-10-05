import { test } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CONTEXT_URI, renderContextResource, readResource } from "../server.js"

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

// ---------------------------------------------------------------------------
// readResource — no entitlement gate. montaj-app's own entitlement check was
// removed (the app's Free tier now works without an account); these resources
// resolve the same way whether or not montaj-app's env vars are present.
//
// JWT-construction helpers below are no longer load-bearing for gating — kept
// only for the "a valid Studio JWT still resolves normally" case, which now
// exercises the same no-op path as everything else.
// ---------------------------------------------------------------------------

const APP_ENV = { MONTAJ_APP_RUNTIME_HOME: "/rt", MONTAJ_APP_VENDOR_ROOT: "/vr" }

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  return {
    publicPem:  publicKey.export({ type: "spki", format: "pem" }),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }),
  }
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url")

function makeJwt(claims, privateKeyPem, header = { alg: "ES256", typ: "JWT" }) {
  const signingInput = `${b64url(header)}.${b64url(claims)}`
  const sig = sign("sha256", Buffer.from(signingInput), { key: privateKeyPem, dsaEncoding: "ieee-p1363" })
  return `${signingInput}.${sig.toString("base64url")}`
}

const studioClaims = () => ({ capabilities: { byoa: true }, exp: Math.floor(Date.now() / 1000) + 3600 })

// A profile URI that cannot exist on any machine, so the "not found" branch
// is deterministic and the test never touches the network — unlike
// montaj://context, whose happy path depends on a live `montaj serve`.
const MISSING_PROFILE_URI = "montaj://profile/__no-such-profile-ever__"

test("readResource: standalone use (no montaj-app env vars) is unaffected — a profile read still resolves normally", async () => {
  const result = await readResource(MISSING_PROFILE_URI, { env: {} })
  assert.deepEqual(result, {
    contents: [{ uri: MISSING_PROFILE_URI, mimeType: "text/plain", text: "Profile '__no-such-profile-ever__' not found." }],
  })
})

test("readResource: standalone use (no montaj-app env vars) is unaffected — montaj://context still resolves normally", async () => {
  const result = await readResource(CONTEXT_URI, { env: {} })
  assert.equal(result.contents[0].uri, CONTEXT_URI)
  assert.doesNotMatch(result.contents[0].text, /studio/i)
  assert.match(result.contents[0].text, /# Editor context/)
})

test("readResource: a valid Studio JWT resolves the resource normally", async () => {
  const { publicPem, privatePem } = keypair()
  const result = await readResource(MISSING_PROFILE_URI, {
    env: APP_ENV,
    readJwt: () => makeJwt(studioClaims(), privatePem),
    readPublicKey: () => publicPem,
  })
  assert.deepEqual(result, {
    contents: [{ uri: MISSING_PROFILE_URI, mimeType: "text/plain", text: "Profile '__no-such-profile-ever__' not found." }],
  })
})

test("an app-mediated env with no entitlement JWT still reads resources (gate removed)", async () => {
  const runtimeHome = mkdtempSync(join(tmpdir(), "mcp-nogate-"))
  const vendorRoot  = mkdtempSync(join(tmpdir(), "mcp-nogate-v-"))
  process.env.MONTAJ_APP_RUNTIME_HOME = runtimeHome
  process.env.MONTAJ_APP_VENDOR_ROOT  = vendorRoot
  try {
    const out = await readResource(CONTEXT_URI)
    assert.ok(Array.isArray(out.contents))
    assert.doesNotMatch(out.contents[0].text, /requires Studio|sign in/i)
  } finally {
    delete process.env.MONTAJ_APP_RUNTIME_HOME
    delete process.env.MONTAJ_APP_VENDOR_ROOT
  }
})

test("open notes render as a Notes section with m:ss times", () => {
  const body = {
    active: true,
    project: { id: "p1", name: "x", durationSec: 20 },
    playhead: { sec: 1, frame: 30 },
    clipAtPlayhead: null,
    selection: [],
    transcriptAroundPlayhead: null,
    ageMs: 10,
  }
  const text = renderContextResource({
    ok: true,
    body: { ...body, notes: [{ t: 12.4, text: "caption covers face" }, { t: 65, tEnd: 70.2, text: "tighten" }] },
  })
  assert.match(text, /## Notes/)
  assert.match(text, /0:12 caption covers face/)
  assert.match(text, /1:05-1:10 tighten/)
  assert.doesNotMatch(renderContextResource({ ok: true, body }), /## Notes/)
})

test("slide notes render with their slide position and point; time notes unchanged", () => {
  const body = {
    active: true,
    project: { id: "c1", name: "deck", durationSec: 0 },
    playhead: { sec: 0, frame: 0 },
    clipAtPlayhead: null,
    selection: [],
    transcriptAroundPlayhead: null,
    ageMs: 10,
    notes: [
      { t: 12.4, tEnd: null, text: "caption covers face" },
      { id: "n1", slide: 3, slideId: "s-c", x: 0.4, y: 0.25, text: "logo  too small" },
      { id: "n2", slide: 1, slideId: "s-a", text: "whole slide" },
      { id: "n3", slide: null, slideId: "s-gone", x: 0.1, y: 0.1, text: "was on a deleted slide" },
    ],
  }
  const text = renderContextResource({ ok: true, body })
  assert.match(text, /## Notes/)
  assert.match(text, /^- 0:12 caption covers face$/m)
  assert.match(text, /^- Slide 3 \(40%, 25%\) logo too small$/m)
  assert.match(text, /^- Slide 1 whole slide$/m)
  assert.match(text, /^- Removed slide was on a deleted slide$/m)
  assert.doesNotMatch(text, /NaN|undefined|null/)
})
