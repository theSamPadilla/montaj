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
/** How many props URLs are fetched at once. */
export const PROPS_FETCH_CONCURRENCY = 6

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
  const results = await pMap(hrefs, href => {
    let p = propsFetches.get(href)
    if (!p) {
      p = fetchPropsUrl(href, { timeoutMs, maxBytes }).catch(error => {
        process.stderr.write(`[montaj] ${error.message}\n`)
        return { error }
      })
      propsFetches.set(href, p)
    }
    return p
  }, PROPS_FETCH_CONCURRENCY)
  return new Map(hrefs.map((href, i) => [href, results[i]]))
}

async function fetchPropsUrl(href, { timeoutMs, maxBytes }) {
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
  const chunks = []
  let total = 0
  try {
    for await (const chunk of res.body ?? []) {
      total += chunk.byteLength
      if (total > maxBytes) throw tooBig()
      chunks.push(chunk)
    }
  } catch (err) {
    if (err instanceof PropsFetchError) throw err
    throw failed(reasonOf(err))
  }
  return {
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    body: Buffer.concat(chunks),
  }
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
 * (a props URL that is not media, so never fetched: overlay-build.js isPropsMediaUrl).
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
 * respond each one (renderer.js's HDR image conversion). `onCached(request)`
 * is told about each request served from the props cache.
 *
 * Returns `{ blocked, failedProps, isBlockNoise(consoleMessage), assertPropsServed() }`:
 * the URLs aborted; the props URLs the page asked for whose prefetch failed
 * (href -> PropsFetchError); whether a console message is only Chromium
 * reporting one of those aborts; and a check that throws the first of those
 * failures. A caller that fails on console errors must skip that noise, or a
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
        : d.kind === 'unfetched' ? `[montaj] not fetched: ${d.url} (a props URL is fetched only when it ends in an image, video, audio, font or data extension)`
        : `[montaj] blocked a network request to ${d.host}`)
      request.abort('blockedbyclient').catch(() => {})
      return
    }
    if (d.action === 'respond') {
      request.respond({
        status: 200,
        contentType: d.response.contentType,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: d.response.body,
      }).catch(() => {})
      if (onCached) onCached(request)
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
  }
}
