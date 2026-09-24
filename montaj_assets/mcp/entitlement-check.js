/**
 * Entitlement guard for MCP tool dispatch.
 *
 * montaj is free software and this file must never change that. It answers one
 * narrow question: *was this MCP server launched by the Montaj desktop app's own
 * generated client config?* If it was not — the standalone `montaj mcp` case,
 * which is every OSS user — nothing here runs and nothing is checked. If it was,
 * the app's cached entitlement decides, because connecting your own AI assistant
 * to the app is a paid (Studio) feature.
 *
 * The two env vars that answer that question are written by montaj-app's
 * mcp-config.cjs into the client config it generates, and reach this process
 * through its launcher. They are absent for every other way of starting this
 * server.
 *
 * The verification mirrors montaj-app's own desktop/src/entitlement.cjs —
 * ES256 over a raw IEEE P1363 (r||s) signature, not DER. Mirrored and NOT
 * shared: this file is OSS and must run with zero dependency on that repo,
 * which is not on disk for anyone but us.
 */
import { readFileSync } from "node:fs"
import { join }         from "node:path"
import { verify, createPublicKey } from "node:crypto"

// Pinned, and only ever COMPARED against — never used to select a verifier.
// A verifier chosen by the token's own header is the whole alg-confusion
// attack (`alg: none`, or HS256 keyed with the public key).
const REQUIRED_ALG = "ES256"
// ES256 raw r||s: two 32-byte big-endian integers. A DER-wrapped signature has
// a different length, so this also catches an encoding mismatch as itself
// rather than as a mysterious verification failure.
const ES256_SIGNATURE_BYTES = 64

function base64urlDecode(str) {
  return Buffer.from(str, "base64url")
}

function decodeJsonSegment(segment) {
  return JSON.parse(base64urlDecode(segment).toString("utf8"))
}

/**
 * Verify the app's cached entitlement JWT. Returns the claims, or throws — every
 * caller below treats a throw as "refuse", so there is no way to fall through
 * this function without a verified token.
 */
function verifyJwt(jwt, publicKeyPem) {
  if (typeof jwt !== "string") throw new Error("token is not a string")
  const parts = jwt.split(".")
  if (parts.length !== 3) throw new Error(`token has ${parts.length} segments, expected 3`)
  const [headerB64, payloadB64, sigB64] = parts

  const header = decodeJsonSegment(headerB64)
  if (header.alg !== REQUIRED_ALG) {
    throw new Error(`token declares alg=${JSON.stringify(header.alg)}, only ${REQUIRED_ALG} is accepted`)
  }

  // Parsed rather than handed to verify() as a raw PEM string, so a bundle
  // shipping something that is not an EC P-256 key fails here, loudly, instead
  // of at a verification step whose failure reads like a bad token.
  const key = createPublicKey(publicKeyPem)
  const curve = key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve
  if (key.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
    throw new Error(`public key is not EC P-256 (got ${key.asymmetricKeyType || "unknown"}${curve ? `/${curve}` : ""})`)
  }

  const signature = base64urlDecode(sigB64)
  if (signature.length !== ES256_SIGNATURE_BYTES) {
    throw new Error(`signature is ${signature.length} bytes, expected ${ES256_SIGNATURE_BYTES} (raw r||s)`)
  }

  let signatureOk = false
  try {
    signatureOk = verify(
      "sha256",
      Buffer.from(`${headerB64}.${payloadB64}`, "ascii"),
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    )
  } catch {
    // A malformed signature can make OpenSSL throw rather than return false.
    signatureOk = false
  }
  if (!signatureOk) throw new Error("signature does not match the app's public key")

  const claims = decodeJsonSegment(payloadB64)

  // `exp` is REQUIRED, not merely checked when present: a token without it
  // would otherwise be a token that never expires. Every token the app's
  // backend issues carries it.
  if (typeof claims.exp !== "number" || !Number.isInteger(claims.exp)) {
    throw new Error("token has no integer exp")
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (claims.exp <= nowSec) throw new Error("token expired")
  // `expiresAt` (epoch MILLISECONDS) is the app's own grace boundary, enforced
  // independently where present so neither field alone holds the window shut.
  if (typeof claims.expiresAt === "number" && claims.expiresAt <= Date.now()) {
    throw new Error("token expired")
  }

  return claims
}

/**
 * The one function server.js calls.
 *
 * `env`/`readJwt`/`readPublicKey` are injected so this is testable without
 * touching a filesystem; production passes none of them and gets the real
 * fs-backed readers below.
 *
 * Fails OPEN (`allowed: true`) in exactly one case: this invocation has no
 * montaj-app involvement at all, which is what keeps standalone `montaj mcp`
 * completely unaffected. Every other outcome fails CLOSED — missing JWT,
 * expired JWT, bad signature, unreadable key, or a real and valid non-Studio
 * account. Note that a HALF-set environment is app involvement, not standalone
 * use, and so fails closed too.
 */
export function checkByoaEntitlement({
  env,
  readJwt = (runtimeHome) => {
    try {
      return readFileSync(join(runtimeHome, "license", "entitlement.jwt"), "utf8").trim()
    } catch {
      return null
    }
  },
  readPublicKey = (vendorRoot) => readFileSync(join(vendorRoot, "entitlement", "public-key.pem"), "utf8"),
} = {}) {
  const runtimeHome = env?.MONTAJ_APP_RUNTIME_HOME
  const vendorRoot  = env?.MONTAJ_APP_VENDOR_ROOT

  if (!runtimeHome && !vendorRoot) {
    return { allowed: true, reason: "not-app-mediated" }
  }
  if (!runtimeHome || !vendorRoot) {
    return {
      allowed: false,
      reason: "montaj-app environment is incomplete — launch this server from Montaj's Connectors tab",
    }
  }

  const jwt = readJwt(runtimeHome)
  if (!jwt) {
    return { allowed: false, reason: "no cached entitlement — sign in to Montaj and try again" }
  }

  let claims
  try {
    claims = verifyJwt(jwt, readPublicKey(vendorRoot))
  } catch (err) {
    return { allowed: false, reason: `entitlement could not be verified (${err.message})` }
  }

  if (claims?.capabilities?.byoa !== true) {
    return { allowed: false, reason: "connecting your own AI assistant requires Studio" }
  }

  return { allowed: true, reason: "studio" }
}
