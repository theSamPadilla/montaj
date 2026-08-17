// render/look.js
/**
 * Vivid look/curve manifest — JS loader for montaj_assets/luts/looks.json.
 *
 * Mirrors lib/look.py: the JSON is the canonical source of truth for which
 * color-grade LUTs exist and which one is the project default ("master
 * look"). Path resolution mirrors render/color-space.js (montaj_assets/luts/
 * is a sibling of montaj_assets/render/, same as montaj_assets/schemas/) —
 * cli/commands/install.py's prod-cache copy step copies `luts` alongside
 * `schemas` and `timeline-core` for exactly this reason.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// LUTs live at montaj_assets/luts/, sibling to this file's parent
// (montaj_assets/render/) — same resolution shape as color-space.js's
// SCHEMA_PATH just above it in that file.
const LUTS_DIR = join(__dirname, '..', 'luts')
const MANIFEST_PATH = join(LUTS_DIR, 'looks.json')

const _DATA = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

/** The manifest's default look id (e.g. "vivid1") — the curve new projects grade with. */
export const MASTER_LOOK = _DATA.masterLook

const _CURVES = _DATA.curves

/** All registered curve ids, in manifest order. */
export function curveIds() {
  return Object.keys(_CURVES)
}

/**
 * Absolute path to the .cube file for `curveId`.
 *
 * `curveId` omitted/null resolves to MASTER_LOOK. Throws if `curveId` is not
 * a registered curve. Mirrors lib/look.py::lut_path.
 */
export function lutPath(curveId = null) {
  const id = curveId ?? MASTER_LOOK
  const curve = _CURVES[id]
  if (!curve) {
    throw new Error(
      `Unknown look curve ${JSON.stringify(id)}. Expected one of `
      + `${JSON.stringify(curveIds())}. Check montaj_assets/luts/looks.json.`
    )
  }
  return join(LUTS_DIR, curve.file)
}
