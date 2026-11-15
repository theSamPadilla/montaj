// render/read-set.js
/**
 * What a 3D chunk's page read while it rendered, and whether all of it is still the same: the half of a cached
 * chunk's validity (segment-cache.js) that the cache key cannot hold, because only the page knows which files it
 * opens (a scene's models and textures, a font sheet).
 *
 * Every request an overlay page makes passes its page guard (page-guard.js installPageGuard). The guard hands each
 * request it allows to `onAllowed`, each props URL it serves from Node's cache to `onCached`, and keeps the URLs it
 * aborted in `blocked`. A recorder (createReadRecorder) sits on the first two, so a chunk's reads are known without
 * parsing its page:
 *   - `files`: every `file:` URL let through, as an absolute path, with its size, mtimeMs and inode stat'ed when the
 *     page asked for it (or `missing: true` when it did not exist). The page's own index.html and bundle.js are left
 *     out: they live in the bundle's random work dir and the page digest already holds their bytes.
 *   - `props`: every props URL served from the cache; its body is hashed when the chunk is kept.
 *   - `blocked`: every URL the guard aborted. A read that was refused shaped the frame too (the overlay drew its
 *     fallback), so a reuse asks the guard again and misses if it would now let one through.
 *   - `network`: any request the guard let through to the network (Google Fonts). Its bytes are Chrome's, never seen
 *     here, so a chunk that made one is never kept.
 *
 * sealReads, when the chunk is kept: every file still has the stat it had when the page asked for it (else it changed
 * mid-chunk and the chunk is not kept), and gets its sha256. checkReads, before a reuse: a file whose size, mtimeMs
 * and inode are all unchanged passes; otherwise its sha256 must match; anything else is a miss. So a file rewritten
 * in place with the same size and its mtime put back is taken as unchanged: the same trade every mtime-based build
 * tool makes, and the price of not hashing every model on every export. A file that now exists where the page found
 * none, or is gone, is a miss.
 */
import { closeSync, openSync, readSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { resolve, sep } from 'path'
import { filePathOf, pageRequestDecision } from './page-guard.js'

const HASH_CHUNK_BYTES = 1 << 20

const sha256Memo = new Map()

/** The stat a read is recorded with: `{ size, mtimeMs, ino }`, `{ notFile: true }`, or `{ missing: true }`. */
export function readStat(path, { stat = statSync } = {}) {
  let st
  try {
    st = stat(path)
  } catch {
    return { missing: true }
  }
  if (!st.isFile()) return { notFile: true }
  return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }
}

const sameStat = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino

/**
 * The sha256 of a file's bytes, read in 1 MB pieces. Remembered for the process by path and stat, so a scene's
 * models are hashed once per render however many chunks read them. Throws when it cannot be read.
 */
export function fileSha256(path, st = readStat(path)) {
  const memo = st.missing || st.notFile ? null : `${path}\0${st.size}\0${st.mtimeMs}\0${st.ino}`
  if (memo && sha256Memo.has(memo)) return sha256Memo.get(memo)
  const hash = createHash('sha256')
  const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES)
  const fd = openSync(path, 'r')
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  const hex = hash.digest('hex')
  if (memo) sha256Memo.set(memo, hex)
  return hex
}

export const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * Records one chunk's reads. `allowed(url)` and `cached(url)` are called from the page guard's `onAllowed` and
 * `onCached`; `reads(blocked)` is the record, with the guard's `blocked` URLs, that renderChunk hands back.
 *
 * @param {{ skipDir?: string|null, stat?: Function }} [opts]  skipDir: the bundle's work dir, whose files are the page
 */
export function createReadRecorder({ skipDir = null, stat = statSync } = {}) {
  const files = new Map()
  const props = new Set()
  const network = new Set()
  const skip = skipDir ? resolve(skipDir) + sep : null
  return {
    // Called from the guard's request handler, so it never throws: a request it cannot place keeps the chunk out.
    allowed(url) {
      try {
        const u = new URL(url)
        if (u.protocol === 'data:' || u.protocol === 'blob:') return
        if (u.protocol !== 'file:') { network.add(`${u.origin}${u.pathname}`); return }
        const path = filePathOf(u)
        if (path === null) { network.add(u.href); return }
        if (skip && resolve(path).startsWith(skip)) return
        if (!files.has(path)) files.set(path, readStat(path, { stat }))
      } catch {
        network.add(String(url))
      }
    },
    cached(url) {
      props.add(url)
    },
    reads(blocked = []) {
      return {
        files: [...files].map(([path, st]) => ({ path, ...st })),
        props: [...props],
        blocked: [...blocked],
        network: [...network],
      }
    },
  }
}

/** A renderJob that hands back no reads (a test's stand-in): an empty read set. */
export const EMPTY_READS = Object.freeze({ files: [], props: [], blocked: [], network: [] })

/**
 * The read set a kept chunk stores in its manifest: each file's sha256, each props body's sha256, the blocked URLs.
 * `{ reads }`, or `{ why }` when the chunk must not be kept: a file that changed while the chunk rendered, a request
 * that reached the network, a props URL that is not in the job's props cache (one fetched on demand), or a read that
 * was not a plain file.
 *
 * @param {object|undefined} reads  createReadRecorder's record (undefined: EMPTY_READS)
 * @param {{ propsCache?: Map<string, { body?: Buffer }> }} job
 */
export function sealReads(reads, job, { stat = statSync, hash = fileSha256 } = {}) {
  const r = reads ?? EMPTY_READS
  if (r.network?.length) return { why: `it fetched from the network (${r.network[0]})` }
  const files = []
  for (const f of r.files ?? []) {
    const now = readStat(f.path, { stat })
    if (f.notFile || now.notFile) return { why: `it read ${f.path}, which is not a file` }
    if (f.missing || now.missing) {
      if (!(f.missing && now.missing)) return { why: `${f.path} changed while it rendered` }
      files.push({ path: f.path, missing: true })
      continue
    }
    if (!sameStat(f, now)) return { why: `${f.path} changed while it rendered` }
    files.push({ path: f.path, size: now.size, mtimeMs: now.mtimeMs, ino: now.ino, sha256: hash(f.path, now) })
  }
  const props = []
  for (const url of r.props ?? []) {
    const body = job.propsCache?.get(url)?.body
    if (!body) return { why: `its props URL ${url} was fetched on demand` }
    props.push({ url, sha256: sha256Of(body) })
  }
  return { reads: { files, props, blocked: [...(r.blocked ?? [])] } }
}

/**
 * null when every read of a kept chunk is as it was, else why not (segment-cache.js logs it). `job` is the job about
 * to reuse it: its props cache and page guard inputs (boundary, needsGoogleFonts) are this render's.
 */
export function checkReads(sealed, job, { stat = statSync, hash = fileSha256 } = {}) {
  for (const f of sealed?.files ?? []) {
    const now = readStat(f.path, { stat })
    if (f.missing) {
      if (!now.missing) return `${f.path} now exists`
      continue
    }
    if (now.missing) return `${f.path} is gone`
    if (now.notFile) return `${f.path} is not a file`
    if (sameStat(f, now)) continue
    let sha
    try { sha = hash(f.path, now) } catch { return `${f.path} cannot be read` }
    if (sha !== f.sha256) return `${f.path} changed`
  }
  for (const p of sealed?.props ?? []) {
    const entry = job.propsCache?.get(p.url)
    if (!entry?.body || sha256Of(entry.body) !== p.sha256) return `props URL ${p.url} changed`
  }
  const ctx = { boundary: job.boundary, propsCache: job.propsCache ?? new Map(), needsGoogleFonts: job.needsGoogleFonts === true }
  for (const url of sealed?.blocked ?? []) {
    let d
    try { d = pageRequestDecision({ url, method: 'GET' }, ctx) } catch { d = { action: 'unknown' } }
    if (d.action !== 'abort') return `${url} is no longer blocked`
  }
  return null
}
