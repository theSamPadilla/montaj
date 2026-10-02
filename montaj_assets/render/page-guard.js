/**
 * page-guard.js — what every overlay page runs under (PV54).
 *
 * An overlay page is a `file://` page in headless Chromium, launched with
 * `--allow-file-access-from-files`, running code an author or an agent wrote.
 * Unguarded, it could read any file the user can (measured: an extensionless
 * file read by `fetch('file:///…')`) and send it off the machine (measured: 20
 * of 21 channels reached a local listener). Everything here closes that, in
 * layers, because no single layer sees every channel:
 *
 *   1. Request interception (installPageGuard). Every request the page makes
 *      that Chromium routes through the network service gets exactly one of
 *      continue, respond or abort, decided by pageRequestDecision:
 *        file:          the read boundary (overlay-build.js) decides
 *        data:, blob:   allowed
 *        http(s) GET    of a URL the props name: served from the props cache,
 *                       fetched by Node BEFORE the page loads (prefetchPropsUrls),
 *                       so which allowed URLs the page asks for never reaches
 *                       the wire
 *        http(s) GET    of a URL the props name with no extension: fetched by
 *                       Node only when the page asks for it, as the editor
 *                       preview loads it, and served only if it is an image
 *                       (fetchOnDemandPropsUrl); so one shown only as text is
 *                       never requested
 *        https GET      to fonts.googleapis.com / fonts.gstatic.com, only on a
 *                       page that links Google Fonts (a family not vendored)
 *        anything else  aborted
 *   2. Launch flags (overlayPageLaunchOptions), for channels interception does
 *      not see (measured with render's puppeteer 22.15 / Chrome 127: the
 *      WebSocket upgrade, a SharedWorker's fetch, a popup's GET, TURN-TCP, STUN
 *      and WebTransport UDP, preconnect):
 *        --host-resolver-rules=MAP * ~NOTFOUND   no host resolves, IP literals
 *                       and localhost included; the two font hosts are
 *                       EXCLUDEd only when a page needs them
 *        --webrtc-ip-handling-policy=disable_non_proxied_udp   no STUN UDP.
 *                       NOT `--force-webrtc-ip-handling-policy`: that spelling
 *                       does nothing (measured)
 *        --disable-popup-blocking removed from puppeteer's defaults, so the
 *                       popup blocker is on
 *        --disable-blink-features=SharedWorker   no SharedWorker constructor:
 *                       its requests are the one read path interception
 *                       cannot see
 *   3. A CSP in the generated page (overlayPageCspMeta): connect-src and
 *      worker-src limited to file:, data:, blob:, the font hosts when needed
 *      and the props URLs.
 *
 * The evidence that layers 2 and 3 WORK is the measurement above, cited in
 * docs (montaj-app PV54), not re-derived by the tests; the tests assert they
 * are IN FORCE. A request those layers stop never reaches the interception
 * handler, so "refused at the handler" would prove nothing for them.
 */
import { fromFileHref } from './file-url.js'
import { pMap } from './p-map.js'

export const GOOGLE_FONT_HOSTS = Object.freeze(['fonts.googleapis.com', 'fonts.gstatic.com'])

/** How long one props URL may take to fetch, body included. */
export const PROPS_FETCH_TIMEOUT_MS = 30_000
/** The largest props URL body fetched; a bigger one is a failed fetch. */
export const PROPS_FETCH_MAX_BYTES = 50 * 1024 * 1024
/** How many props URLs are fetched at once (up front, and on demand). */
export const PROPS_FETCH_CONCURRENCY = 6
/** How many first bytes of an extension-less props URL are read to tell an image. */
export const IMAGE_SNIFF_BYTES = 32
/** How long a capture waits for the page's images (settleImages) before it goes ahead without them. */
export const IMAGE_SETTLE_CAP_MS = PROPS_FETCH_TIMEOUT_MS + 5000

/**
 * How a capture names an image it went ahead without: a file by its path, a
 * web URL without its query (which may carry a token), anything else by its
 * scheme alone (a data: URL is the image itself).
 */
export function describeImageSrc(src) {
  try {
    const u = new URL(src)
    if (u.protocol === 'file:') return fromFileHref(src)
    if (u.protocol === 'http:' || u.protocol === 'https:') return `${u.origin}${u.pathname}`
    return `a ${u.protocol} URL`
  } catch {
    return String(src)
  }
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

/** The `--host-resolver-rules` value for an overlay page's browser. */
export function hostResolverRules({ needsGoogleFonts = false } = {}) {
  // EXCLUDE is per host: `host:port` is ignored (measured), so list bare hosts.
  return ['MAP * ~NOTFOUND', ...(needsGoogleFonts ? GOOGLE_FONT_HOSTS.map(h => `EXCLUDE ${h}`) : [])].join(', ')
}

/**
 * The puppeteer.launch options of every browser that loads an overlay page
 * (renderer.js, sample-frame.js, render-carousel.js). capture-site.js is NOT
 * one: it loads remote pages and must never get the file-access flag.
 *
 * `needsGoogleFonts` opens the two font hosts in the resolver rule, and should
 * be set only when a page this browser loads links Google Fonts.
 * `disableWebSecurity` keeps `--disable-web-security` for the two callers that
 * have always passed it (renderer.js, sample-frame.js); the carousel never has.
 */
export function overlayPageLaunchOptions({ needsGoogleFonts = false, disableWebSecurity = false } = {}) {
  return {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // /tmp instead of the container's 64MB /dev/shm (the Docker default), which
      // a 4K (2160x3840) capture overruns: Chromium crashes mid-render.
      '--disable-dev-shm-usage',
      ...(disableWebSecurity ? ['--disable-web-security'] : []),
      '--allow-file-access-from-files',
      `--host-resolver-rules=${hostResolverRules({ needsGoogleFonts })}`,
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-blink-features=SharedWorker',
    ],
    // puppeteer passes --disable-popup-blocking by default; a popup is a new
    // page this guard is not installed on.
    ignoreDefaultArgs: ['--disable-popup-blocking'],
    protocolTimeout: 300000,
  }
}

// ---------------------------------------------------------------------------
// the generated page
// ---------------------------------------------------------------------------

/** True when a generated page links the Google Fonts stylesheet. */
export function pageNeedsGoogleFonts(html) {
  return html.includes('<link rel="stylesheet" href="https://fonts.googleapis.com/')
}

/**
 * The page CSP. Only the two directives interception needs help with:
 * connect-src (a WebSocket is not intercepted) and worker-src (a worker's own
 * requests may not be). Nothing else is restricted, so a legitimate overlay's
 * scripts, styles, images and fonts load exactly as before.
 */
export function overlayPageCsp({ needsGoogleFonts = false, connectUrls = [] } = {}) {
  const local = ['file:', 'data:', 'blob:']
  const fonts = needsGoogleFonts ? GOOGLE_FONT_HOSTS.map(h => `https://${h}`) : []
  const named = [...new Set(connectUrls.map(cspUrlSource).filter(Boolean))]
  return `connect-src ${[...local, ...fonts, ...named].join(' ')}; worker-src ${local.join(' ')}`
}

/** The CSP as the `<meta>` both renderers' generateHtml emit, identically. */
export function overlayPageCspMeta(opts) {
  const content = overlayPageCsp(opts).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<meta http-equiv="Content-Security-Policy" content="${content}">`
}

// A props URL as an exact CSP source: scheme, host, port and path. CSP matching
// ignores the query, and a source may not carry one; `;` and `,` would end the
// directive or the policy, so they are escaped (CSP compares paths decoded).
function cspUrlSource(u) {
  let url
  try { url = new URL(u) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const path = url.pathname.replace(/;/g, '%3B').replace(/,/g, '%2C')
  return `${url.protocol}//${url.host}${path}`
}

// ---------------------------------------------------------------------------
// props URLs, fetched by Node before the page loads
// ---------------------------------------------------------------------------

/** A props URL that could not be fetched, timed out or was too big. */
export class PropsFetchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PropsFetchError'
  }
}

// href -> Promise<{ contentType, body } | { error }>: each distinct URL is
// fetched once per process (a render or sample process is one job), however
// many pages name it, and a failure is remembered for the job too.
const propsFetches = new Map()

/**
 * Fetch every distinct http(s) URL in `urls` once, at most
 * PROPS_FETCH_CONCURRENCY at a time, and return a Map of href -> entry for
 * exactly those URLs: `{ contentType, body }`, or `{ error }` (a
 * PropsFetchError naming the URL) when it failed, timed out or exceeded the
 * cap. The page guard serves a page's requests for them from this map; the
 * page never reaches the wire.
 *
 * A failure does not throw here. Props also hold URLs that are only shown as
 * text (a link, a QR target), which a render never needed to reach, so a
 * failed URL fails the job only if the page asks for it (installPageGuard's
 * `failedProps`, thrown by `assertPropsServed`). It is logged either way.
 */
export async function prefetchPropsUrls(urls, { timeoutMs = PROPS_FETCH_TIMEOUT_MS, maxBytes = PROPS_FETCH_MAX_BYTES } = {}) {
  const hrefs = [...new Set([...urls].map(u => new URL(u).href))]
  const results = await pMap(hrefs, href => fetchOnce(href, () => fetchPropsUrl(href, { timeoutMs, maxBytes })),
    PROPS_FETCH_CONCURRENCY)
  return new Map(hrefs.map((href, i) => [href, results[i]]))
}

/**
 * Fetch one props URL with no extension (overlay-build.js
 * isExtensionlessPropsUrl: Spotify cover art, an image CDN) that a page asked
 * for: once per process, at most PROPS_FETCH_CONCURRENCY at a time, under the
 * prefetch's timeout, cap and redirect rules. Resolves to `{ contentType, body }`
 * when it is an image (`Content-Type: image/*`, or first bytes that are a PNG,
 * JPEG, WebP, GIF or AVIF: sniffImageType, which then names the type served),
 * `{ notImage: true }` when it is not (its body cancelled on those first
 * bytes), or `{ error }` (a PropsFetchError naming the URL, logged) when it
 * failed, timed out or exceeded the cap. Never rejects.
 */
export function fetchOnDemandPropsUrl(url, { timeoutMs = PROPS_FETCH_TIMEOUT_MS, maxBytes = PROPS_FETCH_MAX_BYTES } = {}) {
  const href = new URL(url).href
  return fetchOnce(href, () => onDemandSlot(() => fetchPropsUrl(href, { timeoutMs, maxBytes, imageOnly: true })))
}

// Each distinct URL is fetched once per process, up front or on demand, and a
// failure is logged once, when it happens.
function fetchOnce(href, start) {
  let p = propsFetches.get(href)
  if (!p) {
    p = start().catch(error => {
      process.stderr.write(`[montaj] ${error.message}\n`)
      return { error }
    })
    propsFetches.set(href, p)
  }
  return p
}

// At most PROPS_FETCH_CONCURRENCY on-demand fetches at once, the rest queued.
let onDemandActive = 0
const onDemandQueue = []
function onDemandSlot(start) {
  return new Promise((resolve, reject) => {
    const run = () => {
      onDemandActive++
      start().then(resolve, reject).finally(() => {
        onDemandActive--
        onDemandQueue.shift()?.()
      })
    }
    if (onDemandActive < PROPS_FETCH_CONCURRENCY) run()
    else onDemandQueue.push(run)
  })
}

// `imageOnly`: keep the body only if it is an image (see fetchOnDemandPropsUrl).
async function fetchPropsUrl(href, { timeoutMs, maxBytes, imageOnly = false }) {
  const mb = Math.round(maxBytes / (1024 * 1024))
  const tooBig = () => new PropsFetchError(`props URL ${href} exceeds ${mb} MB`)
  const failed = reason => new PropsFetchError(`props URL ${href} could not be fetched: ${reason}`)
  const reasonOf = err => (err?.name === 'TimeoutError' || err?.name === 'AbortError')
    ? `timed out after ${Math.round(timeoutMs / 1000)} s`
    : (err?.cause?.code || err?.cause?.message || err?.message || String(err))
  let res
  try {
    res = await fetch(href, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  } catch (err) {
    throw failed(reasonOf(err))
  }
  if (!res.ok) {
    try { await res.body?.cancel() } catch { /* already closed */ }
    throw failed(`HTTP ${res.status}`)
  }
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel() } catch { /* already closed */ }
    throw tooBig()
  }
  const declaredType = res.headers.get('content-type')
  // An extension-less URL not labelled an image is told by its first bytes.
  let sniff = imageOnly && !isImageContentType(declaredType)
  let sniffed = null
  const chunks = []
  let total = 0
  try {
    for await (const chunk of res.body ?? []) {
      total += chunk.byteLength
      if (total > maxBytes) throw tooBig()
      chunks.push(chunk)
      if (sniff && total >= IMAGE_SNIFF_BYTES) {
        sniffed = sniffImageType(Buffer.concat(chunks))
        // Not an image: leaving the loop cancels the body.
        if (sniffed === null) return { notImage: true }
        sniff = false
      }
    }
  } catch (err) {
    if (err instanceof PropsFetchError) throw err
    throw failed(reasonOf(err))
  }
  const body = Buffer.concat(chunks)
  if (sniff) {
    sniffed = sniffImageType(body)
    if (sniffed === null) return { notImage: true }
  }
  return {
    contentType: sniffed ?? (declaredType || 'application/octet-stream'),
    body,
  }
}

/** Whether a Content-Type header names an image (`image/png; …`). */
function isImageContentType(value) {
  return typeof value === 'string' && /^image\/[^\s;]/i.test(value.trim())
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The MIME type of an image told by its first bytes (IMAGE_SNIFF_BYTES are
 * enough): `image/png`, `image/jpeg`, `image/gif`, `image/webp` or
 * `image/avif` (an ISO-BMFF `ftyp` box naming the avif or avis brand), else
 * null.
 */
export function sniffImageType(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const ascii = (from, to) => b.toString('latin1', from, to)
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif'
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    // The major brand (8..12), then the compatible brands after the minor
    // version (16..box end), as far as they were read.
    const end = Math.min(b.readUInt32BE(0), b.length)
    const brands = [ascii(8, 12)]
    for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(at, at + 4))
    if (brands.some(brand => brand === 'avif' || brand === 'avis')) return 'image/avif'
  }
  return null
}

// ---------------------------------------------------------------------------
// the page guard
// ---------------------------------------------------------------------------

/** The filesystem path a file: URL loads, or null when it names none. */
function filePathOf(url) {
  // Chromium loads a file URL's PATH: the query and fragment are not part of
  // the file name, and a non-local host names no file here.
  if (url.host && url.host !== 'localhost') return null
  try {
    return fromFileHref(`file://${url.pathname}`)
  } catch {
    return null
  }
}

/**
 * The decision for one request: `{ action: 'continue' }`,
 * `{ action: 'respond', response }` or `{ action: 'abort', kind: 'read', path }` /
 * `{ action: 'abort', kind: 'network', host }` / `{ action: 'abort', kind: 'props', error }`
 * (a props URL whose prefetch failed) / `{ action: 'abort', kind: 'unfetched', url }`
 * (a props URL that is not media, so never fetched: overlay-build.js isPropsMediaUrl)
 * / `{ action: 'fetch', url }` (a props URL with no extension, fetched now,
 * on demand: installPageGuard).
 * Pure, so each rule is testable without a browser.
 */
export function pageRequestDecision({ url, method = 'GET' }, { boundary, propsCache = new Map(), needsGoogleFonts = false }) {
  let u
  try { u = new URL(url) } catch { return { action: 'abort', kind: 'network', host: String(url).slice(0, 64) } }
  switch (u.protocol) {
    case 'data:':
    case 'blob:':
      return { action: 'continue' }
    case 'file:': {
      const path = filePathOf(u)
      if (path !== null && boundary.allows(path)) return { action: 'continue' }
      return { action: 'abort', kind: 'read', path: path ?? u.href }
    }
    case 'http:':
    case 'https:': {
      if (method === 'GET' && propsCache.has(u.href)) {
        const entry = propsCache.get(u.href)
        return entry.error
          ? { action: 'abort', kind: 'props', error: entry.error }
          : { action: 'respond', response: entry }
      }
      if (method === 'GET' && boundary.onDemandUrls?.has(u.href)) {
        return { action: 'fetch', url: u.href }
      }
      if (boundary.unfetchedUrls?.has(u.href)) {
        return { action: 'abort', kind: 'unfetched', url: `${u.origin}${u.pathname}` }
      }
      if (method === 'GET' && needsGoogleFonts && u.protocol === 'https:' && !u.port
          && !u.username && !u.password && GOOGLE_FONT_HOSTS.includes(u.hostname)) {
        return { action: 'continue' }
      }
      return { action: 'abort', kind: 'network', host: u.host }
    }
    default:
      return { action: 'abort', kind: 'network', host: u.protocol }
  }
}

/**
 * Install the guard on `page`, before its `goto`. Every intercepted request
 * gets exactly one of continue, respond or abort. `onAllowed(request)`, when
 * given, takes over the requests the guard allows and must itself continue or
 * respond each one. `onCached(request)`
 * is told about each request served from the props cache.
 *
 * A props URL with no extension (`fetch`) is fetched when the page asks for
 * it (fetchOnDemandPropsUrl) and then served, or aborted: logged as not
 * fetched when it is not an image, or recorded in `failedProps` when the
 * fetch failed.
 *
 * Returns `{ blocked, failedProps, isBlockNoise(consoleMessage), assertPropsServed(), settleOnDemand(), settleImages() }`:
 * the URLs aborted; the props URLs the page asked for whose fetch failed
 * (href -> PropsFetchError); whether a console message is only Chromium
 * reporting one of those aborts; a check that throws the first of those
 * failures; the wait a capture makes for images fetched on demand; and the
 * wait it makes for every image on the page. A caller that fails on console errors must skip that noise, or a
 * blocked read would fail the job instead of leaving the overlay's own
 * fallback. Every caller calls assertPropsServed() once the page has loaded
 * what it needs: a props image the page asked for and could not get fails the
 * job, naming it, instead of rendering without it.
 */
export async function installPageGuard(page, { boundary, propsCache = new Map(), needsGoogleFonts = false, onAllowed = null, onCached = null } = {}) {
  if (!boundary || typeof boundary.allows !== 'function') {
    throw new TypeError('installPageGuard: a read boundary is required (overlayReadBoundary)')
  }
  const ctx = { boundary, propsCache, needsGoogleFonts }
  const blocked = new Set()
  const failedProps = new Map()
  const logged = new Set()
  const note = line => {
    if (logged.has(line)) return
    logged.add(line)
    process.stderr.write(line + '\n')
  }
  const notFetched = url =>
    `[montaj] not fetched: ${url} (a props URL is fetched only when it ends in an image, video, audio, font or data extension, or has none and serves an image)`
  const serve = (request, response) => {
    request.respond({
      status: 200,
      contentType: response.contentType,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: response.body,
    }).catch(() => {})
    if (onCached) onCached(request)
  }
  const onDemandUrls = [...(boundary.onDemandUrls ?? [])]
  const pending = new Set()
  await page.setRequestInterception(true)
  page.on('request', request => {
    let d
    try {
      d = pageRequestDecision({ url: request.url(), method: request.method() }, ctx)
    } catch {
      d = { action: 'abort', kind: 'network', host: '?' }
    }
    if (d.action === 'abort') {
      blocked.add(request.url())
      if (d.kind === 'props') failedProps.set(request.url(), d.error)
      else note(d.kind === 'read' ? `[montaj] blocked a read outside the allowed folders: ${d.path}`
        : d.kind === 'unfetched' ? notFetched(d.url)
        : `[montaj] blocked a network request to ${d.host}`)
      request.abort('blockedbyclient').catch(() => {})
      return
    }
    if (d.action === 'respond') return serve(request, d.response)
    if (d.action === 'fetch') {
      const url = request.url()
      const p = fetchOnDemandPropsUrl(d.url)
        .then(entry => {
          if (entry.body) return serve(request, entry)
          // Recorded before the abort, so the page's error event and console
          // line come after it.
          blocked.add(url)
          if (entry.error) failedProps.set(url, entry.error)
          else { const u = new URL(d.url); note(notFetched(`${u.origin}${u.pathname}`)) }
          request.abort('blockedbyclient').catch(() => {})
        })
        .catch(() => { blocked.add(url); request.abort('blockedbyclient').catch(() => {}) })
        .finally(() => pending.delete(p))
      pending.add(p)
      return
    }
    if (onAllowed) return onAllowed(request)
    request.continue().catch(() => {})
  })
  return {
    blocked,
    failedProps,
    isBlockNoise(msg) {
      return msg.type() === 'error'
        && /net::ERR_BLOCKED_BY_CLIENT/.test(msg.text())
        && blocked.has(msg.location()?.url)
    },
    assertPropsServed() {
      for (const error of failedProps.values()) throw error
    },
    /**
     * Call before each capture. An image fetched on demand arrives after the
     * page asked for it, so a frame captured at once would show it blank.
     * Waits for every <img> showing one of this page's on-demand URLs to load
     * (and decode) or fail, then for every on-demand fetch already under way.
     * The <img> wait is what makes it deterministic: the element is in the
     * DOM, incomplete, before this runs, however late its request reaches
     * Node. Capped at the fetch timeout plus 5 s (a lazy image off screen
     * never loads). A page whose props name no such URL returns at once,
     * without touching the page.
     */
    async settleOnDemand() {
      if (onDemandUrls.length === 0) return
      await page.evaluate((hrefs, capMs) => {
        const wanted = new Set(hrefs)
        const images = [...document.images].filter(img => wanted.has(img.currentSrc) || wanted.has(img.src))
        const ready = img => (img.complete ? Promise.resolve() : new Promise(resolve => {
          img.addEventListener('load', resolve, { once: true })
          img.addEventListener('error', resolve, { once: true })
        })).then(() => (img.naturalWidth > 0 ? img.decode().catch(() => {}) : undefined))
        return Promise.race([
          Promise.all(images.map(ready)),
          new Promise(resolve => setTimeout(resolve, capMs)),
        ])
      }, onDemandUrls, PROPS_FETCH_TIMEOUT_MS + 5000)
      await Promise.all([...pending])
    },
    /**
     * Call before each capture, after settleOnDemand. Waits for every <img> on
     * the page to load or fail, then decodes each one that loaded, so the
     * capture shows it. An overlay that mounts an image only from a later
     * frame (a screenshot shown once its scene fades in) puts the <img> on a
     * fresh page (every sample, the first frame of every render chunk) in the
     * same commit the capture is for, and a slow load came out as an empty
     * frame (PL22).
     *
     * Capped at IMAGE_SETTLE_CAP_MS: the frame is then captured anyway, never
     * failed, and the images still loading are logged and returned (by
     * describeImageSrc), so the caller can keep that capture out of a cache.
     * An image that already cost this page the cap is not waited for again: a
     * file that never arrives costs one cap per page, not one per frame. A
     * loading="lazy" image is not waited for: one off screen never loads.
     * Each image is decoded once per source, not on every frame.
     */
    async settleImages({ capMs = IMAGE_SETTLE_CAP_MS } = {}) {
      const late = await page.evaluate(capMs => {
        const seen = (window.__montajImages ??= { decoded: new WeakMap(), gaveUp: new WeakSet() })
        const images = [...document.images].filter(img => img.loading !== 'lazy' && !seen.gaveUp.has(img))
        const ready = img => (img.complete ? Promise.resolve() : new Promise(resolve => {
          img.addEventListener('load', resolve, { once: true })
          img.addEventListener('error', resolve, { once: true })
        })).then(() => {
          const src = img.currentSrc
          if (img.naturalWidth === 0 || seen.decoded.get(img) === src) return undefined
          return img.decode().then(() => { seen.decoded.set(img, src) }, () => {})
        })
        let timer
        return Promise.race([
          Promise.all(images.map(ready)),
          new Promise(resolve => { timer = setTimeout(resolve, capMs) }),
        ]).then(() => {
          clearTimeout(timer)
          const stillLoading = images.filter(img => !img.complete)
          for (const img of stillLoading) seen.gaveUp.add(img)
          return stillLoading.map(img => img.currentSrc || img.src)
        })
      }, capMs)
      const missed = [...new Set(late.map(describeImageSrc))]
      if (missed.length) note(`[montaj] captured before these images loaded (${capMs / 1000} s): ${missed.join(', ')}`)
      return missed
    },
  }
}
