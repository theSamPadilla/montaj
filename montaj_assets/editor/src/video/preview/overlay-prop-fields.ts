export type PropFieldKind = 'text' | 'number' | 'boolean' | 'color' | 'image'

export interface PropField {
  name: string
  kind: PropFieldKind
  value: string | number | boolean
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// A string prop that points at an image: a workspace/URL path ending in a known
// image extension (optionally with a query/hash), or a data: image URL. These
// render as a thumbnail + file picker instead of a raw path text field.
const IMAGE_PATH = /\.(?:png|jpe?g|webp|gif|svg|avif|bmp)(?:[?#].*)?$/i

function stringKind(value: string): PropFieldKind {
  if (HEX_COLOR.test(value)) return 'color'
  if (IMAGE_PATH.test(value) || value.startsWith('data:image/')) return 'image'
  return 'text'
}

/**
 * Editable fields for an overlay item, inferred from its stored props.
 * Primitive values only — objects, arrays, functions, null are skipped
 * (they stay untouched in the props object on save). No schema needed,
 * so AI-written profile overlays work the same as shipped templates.
 *
 * String values are sub-typed by shape: `#hex` → color picker, an image path
 * → thumbnail + file picker, everything else → text.
 */
export function inferOverlayPropFields(props: Record<string, unknown> | undefined): PropField[] {
  if (!props) return []
  const fields: PropField[] = []
  for (const [name, value] of Object.entries(props)) {
    if (typeof value === 'boolean') fields.push({ name, kind: 'boolean', value })
    else if (typeof value === 'number' && Number.isFinite(value)) fields.push({ name, kind: 'number', value })
    else if (typeof value === 'string') fields.push({ name, kind: stringKind(value), value })
  }
  return fields
}
