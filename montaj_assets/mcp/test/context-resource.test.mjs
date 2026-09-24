import { test } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"

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
// readResource — entitlement gating (montaj://context and montaj://profile/*
// are as much a live BYOA connection as a tool call, and must be gated the
// same way CallToolRequestSchema is; see entitlement-check.js).
//
// JWT-construction helpers mirrored from entitlement-check.test.mjs rather
// than imported — that file doesn't export them, and they're a few lines.
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

test("readResource: a non-Studio JWT is refused, in this handler's own resource-content shape", async () => {
  const { publicPem, privatePem } = keypair()
  const claims = { capabilities: { byoa: false }, exp: Math.floor(Date.now() / 1000) + 3600 }
  const result = await readResource(MISSING_PROFILE_URI, {
    env: APP_ENV,
    readJwt: () => makeJwt(claims, privatePem),
    readPublicKey: () => publicPem,
  })
  assert.deepEqual(Object.keys(result), ["contents"])
  assert.equal(result.contents.length, 1)
  const [entry] = result.contents
  assert.deepEqual(Object.keys(entry).sort(), ["mimeType", "text", "uri"])
  assert.equal(entry.uri, MISSING_PROFILE_URI)
  assert.equal(entry.mimeType, "text/plain")
  assert.match(entry.text, /studio/i)
  // Must NOT be the CallToolRequestSchema refusal shape ({content, isError}).
  assert.equal(result.content, undefined)
  assert.equal(result.isError, undefined)
})

test("readResource: a missing/invalid entitlement (never signed in) is refused the same way", async () => {
  const result = await readResource(MISSING_PROFILE_URI, {
    env: APP_ENV,
    readJwt: () => null,
    readPublicKey: () => "irrelevant",
  })
  assert.equal(result.contents[0].mimeType, "text/plain")
  assert.match(result.contents[0].text, /sign in/i)
})

test("readResource: refusal happens before any resource-specific work — an otherwise-valid montaj://context read is still blocked", async () => {
  const result = await readResource(CONTEXT_URI, {
    env: APP_ENV,
    readJwt: () => null,
    readPublicKey: () => "irrelevant",
  })
  assert.equal(result.contents[0].uri, CONTEXT_URI)
  assert.doesNotMatch(result.contents[0].text, /# Editor context/)
})
