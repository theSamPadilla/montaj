import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { checkByoaEntitlement } from '../entitlement-check.js'

const APP_ENV = { MONTAJ_APP_RUNTIME_HOME: '/rt', MONTAJ_APP_VENDOR_ROOT: '/vr' }

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    publicPem:  publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')

function makeJwt(claims, privateKeyPem, header = { alg: 'ES256', typ: 'JWT' }) {
  const signingInput = `${b64url(header)}.${b64url(claims)}`
  // ieee-p1363 == the raw r||s encoding the app's own signer emits, NOT DER.
  const sig = sign('sha256', Buffer.from(signingInput), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${sig.toString('base64url')}`
}

const studioClaims = () => ({ capabilities: { byoa: true }, exp: Math.floor(Date.now() / 1000) + 3600 })

test('skips the check entirely when montaj-app env vars are absent (standalone CLI usage)', () => {
  const result = checkByoaEntitlement({ env: {} })
  assert.equal(result.allowed, true)
  assert.equal(result.reason, 'not-app-mediated')
})

test('allows a Studio account (byoa: true) when env vars are present and the JWT is valid', () => {
  const { publicPem, privatePem } = keypair()
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => makeJwt(studioClaims(), privatePem),
    readPublicKey: () => publicPem,
  })
  assert.equal(result.allowed, true)
})

test('refuses a non-Studio account (byoa: false) when env vars are present', () => {
  const { publicPem, privatePem } = keypair()
  const claims = { capabilities: { byoa: false }, exp: Math.floor(Date.now() / 1000) + 3600 }
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => makeJwt(claims, privatePem),
    readPublicKey: () => publicPem,
  })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /studio/i)
})

test('refuses when env vars are present but no JWT exists (never signed in / stale cache)', () => {
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => null,
    readPublicKey: () => 'irrelevant',
  })
  assert.equal(result.allowed, false)
})

test('refuses an expired JWT even with byoa: true', () => {
  const { publicPem, privatePem } = keypair()
  const claims = { capabilities: { byoa: true }, exp: Math.floor(Date.now() / 1000) - 3600 }
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => makeJwt(claims, privatePem),
    readPublicKey: () => publicPem,
  })
  assert.equal(result.allowed, false)
})

test('refuses a JWT signed by a different key (tampered/forged)', () => {
  const real   = keypair()
  const forged = keypair()
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => makeJwt(studioClaims(), forged.privatePem), // signed with the WRONG key
    readPublicKey: () => real.publicPem,                       // verified against the REAL key
  })
  assert.equal(result.allowed, false)
})

// ---------------------------------------------------------------------------
// The classic JWT attacks, pinned. Each of these is a token an attacker can
// author by hand, with no key at all, so each one has to be refused by a check
// that runs BEFORE any signature work decides anything.
// ---------------------------------------------------------------------------

test('refuses an alg:none token (algorithm confusion)', () => {
  const { publicPem } = keypair()
  const header = { alg: 'none', typ: 'JWT' }
  const unsigned = `${b64url(header)}.${b64url(studioClaims())}.`
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => unsigned,
    readPublicKey: () => publicPem,
  })
  assert.equal(result.allowed, false)
})

test('refuses an HS256 token even when its payload claims byoa (alg is pinned, never used to pick a verifier)', () => {
  const { publicPem } = keypair()
  // A symmetric token signed with the PUBLIC key as the HMAC secret — the
  // attack the alg pin exists to stop.
  const header = { alg: 'HS256', typ: 'JWT' }
  const signingInput = `${b64url(header)}.${b64url(studioClaims())}`
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => `${signingInput}.${Buffer.from('whatever').toString('base64url')}`,
    readPublicKey: () => publicPem,
  })
  assert.equal(result.allowed, false)
})

test('refuses a malformed token', () => {
  const { publicPem } = keypair()
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => 'not-a-jwt',
    readPublicKey: () => publicPem,
  })
  assert.equal(result.allowed, false)
})

test('refuses a validly-signed token that carries no exp at all', () => {
  const { publicPem, privatePem } = keypair()
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => makeJwt({ capabilities: { byoa: true } }, privatePem),
    readPublicKey: () => publicPem,
  })
  assert.equal(result.allowed, false)
})

test('refuses when the public key cannot be read (a bundle with no key entitles nobody)', () => {
  const { privatePem } = keypair()
  const result = checkByoaEntitlement({
    env: APP_ENV,
    readJwt: () => makeJwt(studioClaims(), privatePem),
    readPublicKey: () => { throw new Error('ENOENT') },
  })
  assert.equal(result.allowed, false)
})

test('refuses when only one of the two env vars is present', () => {
  for (const env of [{ MONTAJ_APP_RUNTIME_HOME: '/rt' }, { MONTAJ_APP_VENDOR_ROOT: '/vr' }]) {
    const result = checkByoaEntitlement({ env, readJwt: () => null, readPublicKey: () => 'x' })
    assert.equal(result.allowed, false, `half-set env should not fail open: ${JSON.stringify(env)}`)
  }
})
