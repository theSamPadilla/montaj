import { useRef, useState, type ChangeEvent } from 'react'
import type { VisualItem } from '../../schema'
import { inferOverlayPropFields, type PropField } from '../preview/overlay-prop-fields'
import { cn, inspectorInputClass, SwatchInput } from '../../ui'

/**
 * `<OverlayContentPanel>` — the editor's contextual right-hand **Content**
 * properties panel for the selected overlay: the overlay's own primitive
 * props (its text, colors, numbers, toggles, image paths), as opposed to the
 * transform geometry its sibling `OverlayInspector` edits.
 *
 * These fields used to live in the floating, draggable `OverlayPropsModal`,
 * opened by a preview double-click / a Pencil button in the controls bar. That
 * dialog is retired: this is the Content TAB of the same right column
 * `OverlayInspector` (Transform) and `ClipPropertiesPanel` mount into, and it
 * shares their visual language — one collapsible section, `var(--editor-*)`
 * custom properties, `inspectorInputClass` inputs.
 *
 * ── No schema, by design ─────────────────────────────────────────────────
 * The editable fields are INFERRED from whatever primitives the item's `props`
 * happens to carry (see `inferOverlayPropFields`), which is why an AI-written
 * one-off overlay is as editable as a shipped template. Non-primitive props
 * (arrays, objects, null) are not shown and are never touched: every write
 * spreads the item's whole `props` record, so they ride through untouched.
 *
 * ── Commit model ─────────────────────────────────────────────────────────
 * Continuous edits (typing, dragging the OS color picker) PREVIEW per change
 * and COMMIT ON BLUR — one undo step per typing gesture, matching
 * `OverlayInspector`'s number boxes and `ClipPropertiesPanel`'s `DraftField`.
 * Discrete edits (a checkbox, a finished image upload) have no blur to commit
 * on, so they preview and commit back to back as one user-visible action —
 * the same split those two panels make.
 *
 * The modal this replaces had a Save button and a Cancel that restored a
 * pre-open snapshot. Neither survives: a panel is never "open", so there is no
 * open-time snapshot to revert to and no moment at which a Save could be the
 * thing that persists. Undo is the revert path now, and it works because each
 * committed gesture is exactly one undo step.
 *
 * Props-driven and host-agnostic, like the rest of this package: it never
 * reaches into a store. All persistence flows back through the two callbacks,
 * which the host (VideoEditor) wires to its own sync core.
 */
export interface OverlayContentPanelProps {
  /** The single selected item, or null. A null item and one with no editable
   *  props both render the empty state — the component enforces its own
   *  contract rather than trusting the caller to have already filtered. */
  item: VisualItem | null
  /** Live-preview an in-progress edit: no undo entry, no save yet. Carries the
   *  item's FULL next `props` record, not a patch — the caller replaces
   *  `item.props` wholesale. Mirrors `VideoEditor`'s `previewOverlayProps`. */
  onPreview: (nextProps: Record<string, unknown>) => void
  /** Commit the last previewed edit as one undo step + queued save. Fired on
   *  a field's blur, closing the typing gesture. */
  onCommit: () => void
  /** Resolve a workspace path to a servable URL (for image thumbnails). */
  fileUrl?: (path: string) => string
  /** Upload a picked file, returning its new workspace path (for image
   *  "change"). Absent on a non-Montaj host — see `ImageField`. */
  uploadFile?: (file: File) => Promise<string>
  /** Editor theme mode — light/dark. Only affects the image field's upload-
   *  error text (red-400 is sub-AA on a light `--editor-surface`). Absent ->
   *  dark, matching every existing caller. */
  mode?: 'light' | 'dark'
}

const SECTION_CLASS = 'shrink-0 border-b border-[var(--editor-border)] flex flex-col overflow-hidden'
const FIELD_LABEL_CLASS = 'text-[11px] uppercase tracking-wide text-[var(--editor-text)]/55'

/**
 * Image prop control: a thumbnail preview plus a file picker that uploads the
 * chosen file (via the host adapter) and swaps the prop to the returned path.
 * When no `uploadFile` is available (non-Montaj host) it degrades to an
 * editable path text field so the value is still reachable — carried over from
 * `OverlayPropsModal` unchanged, because both halves handle real cases: a
 * workspace path, an http URL, and a `data:image/…` URL all render here.
 *
 * A finished upload is a DISCRETE edit (`onChange`): there is no blur to
 * commit on once the picker has closed.
 */
function ImageField({
  name,
  value,
  fileUrl,
  uploadFile,
  onChange,
  onInput,
  onCommit,
  mode = 'dark',
}: {
  name: string
  value: string
  fileUrl?: (path: string) => string
  uploadFile?: (file: File) => Promise<string>
  /** Discrete — a completed upload. */
  onChange: (v: string) => void
  /** Continuous — a keystroke in the degraded path field. */
  onInput: (v: string) => void
  /** Closes the degraded path field's typing gesture. */
  onCommit: () => void
  mode?: 'light' | 'dark'
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const preview = value ? (fileUrl ? fileUrl(value) : value) : ''

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be re-picked later
    if (!file || !uploadFile) return
    setBusy(true)
    setErr(null)
    try {
      onChange(await uploadFile(file))
    } catch (x) {
      setErr(String(x))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      {preview ? (
        <img
          src={preview}
          alt={name}
          className="h-14 w-14 shrink-0 rounded-md border border-[var(--editor-border)] object-cover bg-black/20"
        />
      ) : (
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-dashed border-[var(--editor-border)] text-[10px] text-[var(--editor-text)]/40">
          none
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-mono text-xs text-[var(--editor-text)]/70" title={value}>
          {value ? value.split('/').pop() : '—'}
        </span>
        {uploadFile ? (
          <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-[var(--editor-border)] px-2.5 py-1 text-xs text-[var(--editor-text)]/80 hover:bg-[var(--editor-text)]/5">
            {busy ? 'Uploading…' : 'Change…'}
            <input
              type="file"
              accept="image/*"
              aria-label={name}
              className="hidden"
              onChange={onPick}
              disabled={busy}
            />
          </label>
        ) : (
          <input
            type="text"
            aria-label={name}
            value={value}
            onChange={e => onInput(e.target.value)}
            onBlur={onCommit}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            className={cn(inspectorInputClass, 'font-mono')}
          />
        )}
        {err && <span className={`text-[11px] ${mode === 'light' ? 'text-red-600' : 'text-red-400'}`}>{err}</span>}
      </div>
    </div>
  )
}

/**
 * One inferred prop, rendered as the control its kind calls for, and the one
 * place this panel's preview/commit split is decided.
 *
 * Split into its own component so it can hold its OWN state — hooks can't live
 * inside a loop, and each field needs an independent "have I been edited"
 * answer. `dirty` is that answer, and it is what stops a blur on an UNTOUCHED
 * field from spending a save: `commit()` reaches `sync.commit()`, which
 * enqueues a save whether or not a transient gesture actually happened. Same
 * reasoning (and the same ref) as `OverlayInspector`'s `ScaleSlider`.
 *
 * `draft` is the fix for the same bug `ClipPropertiesPanel`'s `DraftField`
 * documents: a controlled input bound straight to the incoming value gets its
 * keystrokes clobbered by any re-render arriving mid-edit. It goes non-null
 * the moment the operator types and stays the single source of truth for
 * what's ON SCREEN until blur/Enter clears it; until then the field tracks the
 * previewed value live.
 */
function PropFieldRow({
  field,
  onPreview,
  onCommit,
  fileUrl,
  uploadFile,
  mode = 'dark',
}: {
  field: PropField
  onPreview: (value: string | number | boolean) => void
  onCommit: () => void
  fileUrl?: (path: string) => string
  uploadFile?: (file: File) => Promise<string>
  mode?: 'light' | 'dark'
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const dirty = useRef(false)

  /** A continuous gesture step — no undo entry yet. */
  function preview(value: string | number | boolean) {
    dirty.current = true
    onPreview(value)
  }

  /** Close a typing/picking gesture. A no-op on a field nobody touched. */
  function commit() {
    setDraft(null)
    if (!dirty.current) return
    dirty.current = false
    onCommit()
  }

  /** A discrete, already-final edit — one undo step, no separate blur. */
  function change(value: string | number | boolean) {
    preview(value)
    commit()
  }

  /** Rejects mid-typing states (an empty field, a lone minus) rather than
   *  writing `0` over what the operator hasn't finished typing. The modal this
   *  replaces coerced `''` straight to `0`, which snapped the field back to 0
   *  the instant it was cleared; this is the rule every other numeric field in
   *  the editor already follows (`ClipPropertiesPanel.parseNumberInput`,
   *  `OverlayInspector.handleInput`). */
  function previewNumber(raw: string) {
    setDraft(raw)
    if (raw === '' || raw === '-') return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    preview(value)
  }

  return (
    <div className="flex flex-col gap-1">
      <span className={FIELD_LABEL_CLASS}>{field.name}</span>
      {field.kind === 'boolean' ? (
        <input
          type="checkbox"
          aria-label={field.name}
          checked={field.value as boolean}
          onChange={e => change(e.target.checked)}
          className="h-4 w-4 accent-[var(--editor-accent)]"
        />
      ) : field.kind === 'number' ? (
        <input
          type="number"
          aria-label={field.name}
          value={draft ?? String(field.value)}
          onChange={e => previewNumber(e.target.value)}
          onBlur={commit}
          // Enter closes the typing gesture the same way blur does — it does
          // not duplicate the commit logic, just triggers the same onBlur path.
          onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
          className={cn(inspectorInputClass, 'text-right')}
        />
      ) : field.kind === 'color' ? (
        // SwatchInput already splits live picking from the picker closing, so
        // it maps onto preview/commit directly — no draft needed, a color
        // input has no partial value to protect.
        <SwatchInput
          value={String(field.value)}
          ariaLabel={field.name}
          onChange={v => preview(v)}
          onCommit={() => commit()}
        />
      ) : field.kind === 'image' ? (
        <ImageField
          name={field.name}
          value={String(field.value)}
          fileUrl={fileUrl}
          uploadFile={uploadFile}
          onChange={v => change(v)}
          onInput={v => { setDraft(v); preview(v) }}
          onCommit={commit}
          mode={mode}
        />
      ) : (
        <textarea
          aria-label={field.name}
          value={draft ?? String(field.value)}
          rows={1}
          onChange={e => { setDraft(e.target.value); preview(e.target.value) }}
          onBlur={commit}
          className={cn(inspectorInputClass, 'h-auto resize-y')}
        />
      )}
    </div>
  )
}

export default function OverlayContentPanel({
  item,
  onPreview,
  onCommit,
  fileUrl,
  uploadFile,
  mode = 'dark',
}: OverlayContentPanelProps) {
  // Derived on EVERY render, never held in state. The modal seeded a `draft`
  // array once in a `useState` initializer, which it could get away with
  // because it remounted on every open; a panel that stays mounted while the
  // operator clicks from overlay to overlay would keep showing the PREVIOUS
  // overlay's fields. Same reasoning as OverlayInspector deriving `uniform`
  // from the item rather than storing it.
  const props = item?.props ?? {}
  const fields = inferOverlayPropFields(props)

  // Deliberately NO collapsible section header, unlike its siblings. The tab
  // strip immediately above this already reads "Content", and a "CONTENT"
  // section header under a "Content" tab is the same word twice in 40px of
  // chrome — it also made `getByText('Content')` ambiguous at the VideoEditor
  // seam. Collapsing is what the OTHER tab is for. The section FRAME stays, so
  // the column's bottom border lines up whichever tab is showing.
  //
  // `OverlayInspector` still draws its own "TRANSFORM" header; folding that one
  // away is a change to a file this task does not own.
  return (
    <div className={SECTION_CLASS}>
      <div className="flex flex-col gap-3 p-2">
        {fields.length === 0 ? (
          <p className="px-1 py-4 text-center text-[11px] text-[var(--editor-text)]/45">
            {item
              ? 'This overlay has no editable content.'
              : 'Select an overlay to edit its content.'}
          </p>
        ) : (
          fields.map(field => (
            <PropFieldRow
              key={field.name}
              field={field}
              // Every write spreads the item's whole `props` record, so the
              // non-primitive props `inferOverlayPropFields` skipped (arrays,
              // objects, null) survive untouched rather than being dropped.
              onPreview={value => onPreview({ ...props, [field.name]: value })}
              onCommit={onCommit}
              fileUrl={fileUrl}
              uploadFile={uploadFile}
              mode={mode}
            />
          ))
        )}
      </div>
    </div>
  )
}
