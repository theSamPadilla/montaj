// render/color-space.js
/**
 * Project working color space — JS loader for docs/schemas/color_space.json.
 *
 * The JSON is the canonical source of truth (loaded by both Python and JS). This
 * module exposes camelCase accessors and detection helpers.
 *
 * Note on key naming convention: the JSON uses snake_case (output_pix_fmt,
 * encoder_params) to match Python conventions; this loader converts to
 * camelCase (outputPixFmt, encoderArgs) at load time so JS call sites read
 * idiomatically. The conversion is explicit — no lodash.camelCase magic —
 * because there are only ~7 fields per spec and explicit beats clever.
 *
 * The JSON's encoder_params dict translates 1:1 into the ordered ffmpeg argv
 * list each encoder run actually consumes. The loader preserves dict insertion
 * order (JavaScript Object spec; Node uses V8 which keeps insertion order for
 * string keys) and converts to ['-key', 'value', ...] form.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Resolve up to repo root, then into docs/schemas/. Sibling to this file is
// montaj_assets/render/, so the path is ../../docs/schemas/color_space.json.
const SCHEMA_PATH = join(__dirname, '..', '..', 'docs', 'schemas', 'color_space.json')

const _DATA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))

export const ALL_COLOR_SPACES = Object.freeze(_DATA.all)
export const DEFAULT_COLOR_SPACE = _DATA.default

// Build per-spec views with encoder_params expanded into argv form for direct
// passing to ffmpeg. Frozen to prevent accidental mutation at the call site.
function buildSpecs(rawSpecs) {
  const out = {}
  for (const [key, raw] of Object.entries(rawSpecs)) {
    const encoderArgs = []
    for (const [k, v] of Object.entries(raw.encoder_params)) {
      encoderArgs.push(`-${k}`, v)
    }
    out[key] = Object.freeze({
      key: raw.key,
      transferValues: Object.freeze([...raw.transfer_values]),
      pixFmts: Object.freeze([...raw.pix_fmts]),
      encoder: raw.encoder,
      outputPixFmt: raw.output_pix_fmt,
      encoderArgs: Object.freeze(encoderArgs),
      outputColorArgs: Object.freeze([...raw.output_color_args]),
      setparams: raw.setparams,
    })
  }
  return Object.freeze(out)
}

export const COLOR_SPACE_SPECS = buildSpecs(_DATA.specs)

export function specFor(key) {
  return COLOR_SPACE_SPECS[key] ?? COLOR_SPACE_SPECS[DEFAULT_COLOR_SPACE]
}

/**
 * Strict validator. Throws if `key` is not a known color space. Use at load
 * sites (e.g., reading projectJson.settings.colorSpace) where a hand-edited
 * bad value should fail loudly rather than silently coerce. Mirrors
 * lib/types/colorspace.py::require_valid_key.
 */
export function requireValidKey(key) {
  if (key == null || !ALL_COLOR_SPACES.includes(key)) {
    throw new Error(
      `Unknown colorSpace ${JSON.stringify(key)}. Expected one of `
      + `${JSON.stringify([...ALL_COLOR_SPACES])}. Check project.json `
      + `settings.colorSpace.`
    )
  }
  return key
}

export function detectFromTransfer(colorTransfer) {
  if (!colorTransfer) return DEFAULT_COLOR_SPACE
  for (const [key, spec] of Object.entries(COLOR_SPACE_SPECS)) {
    if (spec.transferValues.includes(colorTransfer)) return key
  }
  return DEFAULT_COLOR_SPACE
}

/**
 * Pick a project color space from a list of per-clip detected keys.
 * Mirrors lib/types/colorspace.py::smart_detect — keep the two in sync.
 *
 * Policy: modal wins. Tiebreak rules:
 *   - SDR tied with HDR → SDR (conservative; inverse-stretch is guesswork).
 *   - HLG+PQ tied (no SDR) → PQ (larger gamut, clean transfer conversion).
 *   - Any other tie → SDR.
 * Empty list → SDR default.
 */
export function smartDetect(detectedKeys) {
  if (!detectedKeys.length) return DEFAULT_COLOR_SPACE

  const counts = new Map()
  for (const k of detectedKeys) counts.set(k, (counts.get(k) ?? 0) + 1)

  const maxCount = Math.max(...counts.values())
  const modes = [...counts.entries()].filter(([, c]) => c === maxCount).map(([k]) => k)

  if (modes.length === 1) return modes[0]
  if (modes.includes(DEFAULT_COLOR_SPACE)) return DEFAULT_COLOR_SPACE
  const modeSet = new Set(modes)
  if (modeSet.size === 2 && modeSet.has('hdr_hlg') && modeSet.has('hdr_pq')) return 'hdr_pq'
  return DEFAULT_COLOR_SPACE
}
