// The vendored-font partition, shared by the package's two Google Fonts
// loaders (`lib/google-fonts.ts` and `text/FontPicker.tsx`).
//
// The two loaders stay independent — separate setters, separate injection
// state, neither imports the other — but they must reach the SAME answer about
// which families a vendored stylesheet covers. That is not a style preference:
// a family served locally by one and from Google by the other is a caption
// laid out in one face while editing and a different one at export, which is
// the bug `skills/write-overlay/SKILL.md`'s Syne case study exists to document.
//
// The two renderers (`montaj_assets/render/bundle.js`,
// `render-carousel.js`) keep hand-copied versions of these same three
// functions, textually pinned against each other by `shim-bake.test.mjs`. They
// have to copy: they are separate CLI entry points that share no module and
// cannot import this package. These two loaders CAN import, so they do —
// a copy that cannot drift beats a copy pinned not to.

/** A `googleFonts` entry is a SPEC, not a family name: "Baloo+2:wght@400;500",
 *  "Playfair+Display:ital@1", "Anton". Everything from the first ':' is the
 *  axis list, and '+' is how Google's API encodes the space in a family name —
 *  strip the one, undo the other, and what is left is the family exactly as
 *  `fonts.css` spells it in its `font-family` declarations, which is what the
 *  vendored family list holds.
 *
 *  Case-folded because CSS font-family matching is case-insensitive: a spec
 *  that differs from the list only in case names a family the vendored
 *  stylesheet genuinely serves, and treating it as unvendored would buy
 *  nothing but a fetch from Google. */
export function fontFamilyKey(spec: string): string {
  return String(spec).split(':')[0].replace(/\+/g, ' ').trim().toLowerCase()
}

/** Normalise a host-supplied family list into the comparison set.
 *
 *  List entries go through `fontFamilyKey` too, not just the requested specs.
 *  Deliberate leniency: a host that passes Google's '+'-encoded spelling
 *  ("Open+Sans") rather than the `fonts.css` one still matches, and the
 *  failure it avoids is silent egress for a family sitting right there on
 *  disk. Non-strings are dropped rather than coerced — a number in the list
 *  is a host bug, and `String(7)` would silently become a "family". */
export function vendoredKeySet(families: readonly unknown[] | undefined): Set<string> {
  if (!Array.isArray(families)) return new Set()
  return new Set(families.filter((f): f is string => typeof f === 'string').map(fontFamilyKey))
}

/** Split requested specs into the ones the vendored stylesheet covers and the
 *  ones that must still come from Google. Order within each list is the
 *  caller's original order, so the googleapis URL reads the way the project
 *  declared it. */
export function partitionFontSpecs(
  specs: readonly string[],
  vendoredKeys: Set<string>,
  faceIndex?: FaceIndex,
): { vendored: string[]; fellThrough: string[] } {
  const vendored: string[] = []
  const fellThrough: string[] = []
  for (const spec of specs) {
    const covered =
      vendoredKeys.has(fontFamilyKey(spec)) && (!faceIndex || specFacesAvailable(spec, faceIndex))
    ;(covered ? vendored : fellThrough).push(spec)
  }
  return { vendored, fellThrough }
}

// ---------------------------------------------------------------------------
// Faces: the family list is not precise enough on its own
// ---------------------------------------------------------------------------
//
// The vendored set is family + STYLE + WEIGHT, not family. `fonts.css` carries
// only the faces the vendoring pass actually received — every face is
// `font-style: normal`, and the weights are only the ones it asked for. So a
// family-level partition gets `Playfair+Display:ital@1` wrong: the family
// matches, the spec is treated as vendored, the real italic is never fetched,
// and the browser synthesises an oblique from the upright. `Inter:wght@300` is
// the same shape one axis over. Both are silent — no failed request, nothing
// on screen — and both change what the user sees, which is the entire defect
// this refinement removes.
//
// The face index REFINES the family partition and can only ever move a spec
// from "vendored" to "fell through", never the reverse. Passing no index means
// no refinement, which is the family-level behaviour that predates this.

export type FaceList = { normal?: readonly number[]; italic?: readonly number[] }
export type FaceMap = Readonly<Record<string, FaceList>>
export type FaceIndex = Map<string, { normal: Set<number>; italic: Set<number> }>

/** Resolve a `googleFonts` SPEC to the concrete faces it asks Google for, or
 *  `null` for "I cannot parse this confidently".
 *
 *  `null` MUST be treated as a fall-through by the caller. That is the safe
 *  direction and it is this feature's established philosophy: fetching a font
 *  we happen to have costs one request, while silently dropping one we lack
 *  costs the author a wrong face in a finished export with no visible cause.
 *
 *  A spec is `Family[:axes@tuples]`, where the axes are named in one
 *  comma-separated list and their values in another, POSITIONALLY:
 *
 *    Anton                                   → normal 400  (Google's default)
 *    Inter:wght@400;700                      → normal 400, normal 700
 *    Playfair+Display:ital@1                 → italic 400
 *    Playfair+Display:ital,wght@1,700        → italic 700
 *    Playfair+Display:ital,wght@0,400;1,700  → normal 400, italic 700
 *
 *  `ital@0` is normal and `ital@1` is italic. Any other axis (`opsz`, `slnt`,
 *  a custom one like `GRAD`), any variable RANGE (`wght@100..900`), a
 *  duplicated axis, or a tuple whose arity does not match the axis list all
 *  return `null` rather than a guess. */
export function requiredFaces(spec: string): { style: 'normal' | 'italic'; weight: number }[] | null {
  const s = String(spec)
  const colon = s.indexOf(':')
  // No axis list: Google serves the family's default face, which is normal 400.
  if (colon === -1) return [{ style: 'normal', weight: 400 }]

  const axisPart = s.slice(colon + 1)
  const at = axisPart.indexOf('@')
  // `Family:` with no '@' at all, or more than one — not a shape we model.
  if (at === -1 || axisPart.indexOf('@', at + 1) !== -1) return null

  const axes = axisPart.slice(0, at).split(',')
  const tuples = axisPart.slice(at + 1).split(';')
  const iItal = axes.indexOf('ital')
  const iWght = axes.indexOf('wght')
  // Every axis must be one we model. An unmodelled, duplicated or empty axis
  // name makes the face set unknowable, and a guess here is the silent-wrong
  // answer this whole refinement exists to delete.
  for (let i = 0; i < axes.length; i++) if (i !== iItal && i !== iWght) return null

  const faces: { style: 'normal' | 'italic'; weight: number }[] = []
  for (const tuple of tuples) {
    const values = tuple.split(',')
    if (values.length !== axes.length) return null
    let style: 'normal' | 'italic' = 'normal'
    let weight = 400
    if (iItal !== -1) {
      const v = values[iItal]
      if (v === '0') style = 'normal'
      else if (v === '1') style = 'italic'
      else return null // an `ital` range (0..1), or junk
    }
    if (iWght !== -1) {
      const v = values[iWght]
      if (!/^\d{1,4}$/.test(v)) return null // a `wght` range (100..900), or junk
      weight = Number(v)
      if (weight < 1 || weight > 1000) return null
    }
    faces.push({ style, weight })
  }
  return faces
}

/** Build the face index from the manifest's `faces` and `requested` maps.
 *
 *  A face counts as AVAILABLE if it is in `faces` (we have the file) or in
 *  `requested` (we asked Google for it and were refused). The second half is
 *  not a special case: the gap between the two maps is exactly "weights Google
 *  does not publish", and falling through for one of those fetches a
 *  stylesheet that declines identically — a guaranteed-useless request rather
 *  than a probably-useless one. `Bebas+Neue:wght@400;700` is the only spec
 *  that exercises it today; Bebas Neue ships no 700 face at all.
 *
 *  Family keys go through `fontFamilyKey`, matching `vendoredKeySet`'s
 *  leniency, so a manifest written with Google's '+'-encoded spelling still
 *  matches. Malformed entries are skipped rather than thrown on: a manifest
 *  this code cannot read must degrade to "no information", never to a crash
 *  inside a fire-and-forget font load. */
export function vendoredFaceIndex(faces?: FaceMap, requested?: FaceMap): FaceIndex | undefined {
  const usable = [faces, requested].filter((m) => m && typeof m === 'object' && !Array.isArray(m))
  // NO face information at all is different from face information that covers
  // nothing. The first leaves the partition at family level (the behaviour
  // that predates this refinement, for a manifest or a host that predates it
  // too); the second says every requested face is genuinely absent. Returning
  // an empty Map for both would silently turn an old manifest into "nothing is
  // vendored", which is safe but wrong to do without saying so.
  if (!usable.length) return undefined

  const index: FaceIndex = new Map()
  for (const source of usable as FaceMap[]) {
    for (const [family, styles] of Object.entries(source)) {
      if (!styles || typeof styles !== 'object') continue
      const key = fontFamilyKey(family)
      let entry = index.get(key)
      if (!entry) index.set(key, (entry = { normal: new Set(), italic: new Set() }))
      for (const style of ['normal', 'italic'] as const) {
        const weights = styles[style]
        if (!Array.isArray(weights)) continue
        for (const w of weights) if (Number.isInteger(w)) entry[style].add(w as number)
      }
    }
  }
  return index
}

/** Whether every face `spec` requires is available locally.
 *
 *  A family with no entry in the index is NOT covered — the index is built
 *  from the same manifest as the family list, so a family present in one and
 *  absent from the other means the two disagree, and the safe reading of a
 *  disagreement is "fall through".
 *
 *  A PARTIALLY vendored spec falls through WHOLE. `Inter:wght@400;300` goes to
 *  Google as one spec rather than being split into a vendored half and a
 *  fetched half. Splitting would mean synthesising a new spec string, and a
 *  spec is the author's — ours to honour or to pass on untouched, never to
 *  rewrite. */
export function specFacesAvailable(spec: string, index: FaceIndex): boolean {
  const entry = index.get(fontFamilyKey(spec))
  if (!entry) return false
  const required = requiredFaces(spec)
  if (!required) return false
  return required.every((f) => entry[f.style].has(f.weight))
}

/** A short, stable fingerprint of a vendored set, logged once by each loader
 *  and once per render by each renderer. It turns an invisible divergence into
 *  two visibly different strings: if the editor's digest and the render's
 *  digest disagree, the two sides are partitioning against different vendored
 *  sets and captions WILL differ between editing and export. QA compares two
 *  hashes instead of trying to observe a partition.
 *
 *  **It fingerprints the FACES, not just the families, when face information
 *  is available.** A families-only digest would report a match across a set
 *  that materially changed — re-vendor at a different weight, or drop one, and
 *  every family name is still identical while what the stylesheet can actually
 *  resolve is not. That is precisely the silent drift this exists to make
 *  loud, so the weights and styles go into the input too.
 *
 *  With NO face index the input is byte-for-byte what it was before faces
 *  existed, so a family-only manifest keeps producing its old digest and stays
 *  comparable against an older renderer. A face index therefore changes the
 *  value exactly when there is new information to report, never incidentally.
 *
 *  FNV-1a over the sorted lines, not a crypto hash, and that is deliberate: it
 *  must be computable synchronously in a browser (`crypto.subtle` is async),
 *  and it is a comparison token, never a security primitive.
 *
 *  The renderers carry the same algorithm in plain JS. The gate that keeps the
 *  two languages honest is a literal digest pinned in BOTH test suites for the
 *  same manifest — this TS↔JS seam is the one place a textual comparison
 *  cannot reach, which is why the literal is the pin. */
export function familiesDigest(keys: Iterable<string>, faceIndex?: FaceIndex): string {
  const lines = [...keys].sort().map((key) => {
    const entry = faceIndex ? faceIndex.get(key) : undefined
    if (!entry) return key
    const axis = (style: 'normal' | 'italic') =>
      `${style}:${[...entry[style]].sort((a, b) => a - b).join(',')}`
    return `${key}\t${axis('normal')}\t${axis('italic')}`
  })
  let h = 0x811c9dc5
  for (const ch of lines.join('\n')) {
    h = Math.imul(h ^ (ch.codePointAt(0) as number), 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** One line naming the vendored set a loader is about to partition against,
 *  or — when a base was set without one — the loud warning that nothing will
 *  be treated as vendored.
 *
 *  "No list" means every requested family goes to Google and the vendored
 *  stylesheet is not linked at all. The tempting opposite, assuming the sheet
 *  covers what was asked for, is the SILENT-wrong option: an unvendored family
 *  would get no stylesheet at all and preview as a system fallback, while the
 *  render — reading its own manifest off local disk, where it cannot fail
 *  independently — would fetch that same family from Google and get it right.
 *  Preview and export would disagree with nothing on screen to say so. This
 *  way is loud-wrong instead: every glyph is correct, both sides agree, and
 *  the only cost is egress, which is the one failure this logging detects. */
export function reportVendoredSet(base: string, vendoredKeys: Set<string>, faceIndex?: FaceIndex): void {
  if (!vendoredKeys.size) {
    console.warn(
      `[montaj] fonts: a base was set (${base}) with no vendored family list — treating NOTHING as vendored, `
        + 'so the vendored stylesheet is not linked and every requested family is fetched from fonts.googleapis.com',
    )
    return
  }
  console.info(`[montaj] fonts: vendored set ${familiesDigest(vendoredKeys, faceIndex)} (${vendoredKeys.size} families) at ${base}`)
}

/** Name the families that crossed to Google. An author who names a family the
 *  vendored set does not carry should learn it while editing, not by noticing
 *  the wrong face in a finished export. Mirrors the renderers' line of the
 *  same text so a log from either side reads identically. */
export function reportUnvendoredFonts(fellThrough: readonly string[]): void {
  if (!fellThrough.length) return
  console.warn(`[montaj] fonts: not in the vendored set, fetching from fonts.googleapis.com: ${fellThrough.join(', ')}`)
}
