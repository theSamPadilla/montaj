import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import {
  baseTextStyle,
  cleanPatch,
  diffEdit,
  encodeRuns,
  liftShared,
  normalizeRuns,
  rangeStyle,
  rebaseRuns,
  spliceRuns,
  styleRange,
  type BaseTextStyle,
  type Run,
  type RunPatch,
} from './runs'
import { matchesRedo, matchesUndo } from '../video/keymap'

// The inline text editor: a contenteditable over the text, drawing the text's
// styled runs (§587 round 3), so a word turned red shows red while editing (a
// textarea draws one style, and an overlay mirroring it drifts once a run is
// bold). The editor keeps its own model, the text and its runs; the DOM is
// read back after every input and the change re-applied to the model, so runs
// stay aligned whatever the browser did. Paste, Enter and the browser's own
// formatting are taken over; typing is left to the browser. So is undo: the
// browser's own history breaks on every repaint, so the editor keeps its own.

export interface InlineTextEditorHandle {
  /** The selected range in the text, or null when nothing is selected. */
  range: () => { start: number; end: number } | null
  /** Styles the selected range and writes the text with its runs (one undo step). */
  applyStyle: (patch: RunPatch) => void
  /** Draws `patch` on the selected range without writing it; null draws what is written. */
  previewStyle: (patch: RunPatch | null) => void
}

export type InlineTextEditorProps = {
  initialValue: string
  /** The text's runs when it has valid ones. */
  initialRuns?: Run[] | null
  /** The element's own style when the edit began; the runs are relative to it. */
  base?: BaseTextStyle
  /** Whether a range can be styled (the template draws runs). */
  styled?: boolean
  rect: { left: number; top: number; width: number; height: number }
  styleSnapshot: Partial<CSSStyleDeclaration>
  /**
   * The edit ends with a change: the text, its runs and the `base` they are
   * relative to, the element's style as this edit last wrote it.
   */
  onCommit: (value: string, runs: Run[], base: BaseTextStyle) => void
  onCancel: () => void
  onChange: (value: string) => void
  /** A style action's write, made while the edit stays open. */
  onWrite?: (value: string, runs: Run[], base: BaseTextStyle) => void
  /** The selected range's style, or null when nothing is selected. */
  onRangeStyle?: (style: BaseTextStyle | null) => void
  handleRef?: Ref<InlineTextEditorHandle>
}

/** Presses inside an element carrying this attribute keep the edit open (the style buttons, the colour panel). */
export const KEEP_TEXT_EDIT = 'data-keep-text-edit'
const inKeepZone = (n: EventTarget | null) => n instanceof Element && !!n.closest(`[${KEEP_TEXT_EDIT}]`)

const PLAIN: BaseTextStyle = baseTextStyle({})

/** One step of the editor's own undo: the text, its runs and where the selection was. */
type Snapshot = { text: string; runs: Run[]; sel: { start: number; end: number } | null }
const HISTORY_CAP = 100
// Typing within this long of the last typed change joins its undo step.
const TYPING_JOIN_MS = 1000

/** A run's look in the editor; underline is drawn per run, since a child cannot take back its parent's. */
function paintRun(span: HTMLSpanElement, r: Run, base: BaseTextStyle) {
  span.style.textDecorationLine = (r.u === undefined ? base.underline : r.u === 1) ? 'underline' : 'none'
  if (r.c !== undefined) span.style.color = r.c
  if (r.b !== undefined) span.style.fontWeight = r.b === 1 ? '700' : '400'
  if (r.i !== undefined) span.style.fontStyle = r.i === 1 ? 'italic' : 'normal'
}

// The trailing <br> every paint ends with: it gives an empty editor, and a
// text ending in a newline, its last line. It is not part of the text.
const isTail = (root: HTMLElement, n: Node) => n.nodeName === 'BR' && n === root.lastChild

function leafLength(root: HTMLElement, n: Node): number {
  if (n.nodeType === Node.TEXT_NODE) return (n as Text).data.length
  if (n.nodeName === 'BR') return isTail(root, n) ? 0 : 1
  let len = 0
  n.childNodes.forEach((c) => { len += leafLength(root, c) })
  return len
}

function readText(root: HTMLElement): string {
  let out = ''
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n as Text).data
    else if (n.nodeName === 'BR') { if (!isTail(root, n)) out += '\n' }
    else n.childNodes.forEach(walk)
  }
  root.childNodes.forEach(walk)
  return out
}

/** The text index of a DOM point inside `root`, or null when it is outside. */
function indexOf(root: HTMLElement, node: Node, offset: number): number | null {
  if (node !== root && !root.contains(node)) return null
  let count = 0
  const visit = (n: Node): boolean => {
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) count += offset
      else for (let i = 0; i < offset && i < n.childNodes.length; i++) count += leafLength(root, n.childNodes[i])
      return true
    }
    if (n.nodeType === Node.TEXT_NODE || n.nodeName === 'BR') { count += leafLength(root, n); return false }
    for (const c of Array.from(n.childNodes)) if (visit(c)) return true
    return false
  }
  return visit(root) ? count : null
}

/** The DOM point at text index `index`: the end of a run rather than the start of the next. */
function pointAt(root: HTMLElement, index: number): [Node, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let seen = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = (n as Text).data.length
    if (len > 0 && index <= seen + len) return [n, index - seen]
    seen += len
  }
  return [root, Math.max(0, root.childNodes.length - 1)]
}

export function InlineTextEditor({
  initialValue,
  initialRuns,
  base = PLAIN,
  styled = false,
  rect,
  styleSnapshot,
  onCommit,
  onCancel,
  onChange,
  onWrite,
  onRangeStyle,
  handleRef,
}: InlineTextEditorProps): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  // The text and its runs as edited; what was last written (the commit's baseline).
  const model = useRef<{ text: string; runs: Run[] }>({
    text: initialValue,
    runs: initialRuns ?? (initialValue ? [{ t: initialValue }] : []),
  })
  // The runs are relative to the element's style as it was when the edit began.
  const own = useRef(base).current
  const written = useRef({ text: initialValue, runs: encodeRuns(normalizeRuns(initialRuns ?? [], own)) })
  // The element's style as this edit last wrote it: a style moved onto the
  // element (select all, Bold) changes it, and later writes are relative to it.
  const wrote = useRef(own)
  // The last selected range (kept while the colour panel has the focus).
  const range = useRef<{ start: number; end: number } | null>(null)
  // The last selection, a caret included: where an undo puts it back.
  const caret = useRef<{ start: number; end: number } | null>(null)
  const history = useRef<{ past: Snapshot[]; future: Snapshot[]; typedAt: number }>({ past: [], future: [], typedAt: 0 })
  const composing = useRef(false)
  // A press that keeps the edit open: the blur that follows it does not end it.
  const keepPress = useRef(false)
  // Set once the editor has handed its result back, so the blur that follows an
  // Enter or Esc (the editor unmounting) does not write a second time.
  const settled = useRef(false)
  const latest = useRef({ styled, onCommit, onCancel, onChange, onWrite, onRangeStyle })
  latest.current = { styled, onCommit, onCancel, onChange, onWrite, onRangeStyle }

  function selection(): { start: number; end: number } | null {
    const root = ref.current
    const sel = typeof window !== 'undefined' ? window.getSelection() : null
    if (!root || !sel || sel.rangeCount === 0) return null
    const r = sel.getRangeAt(0)
    const start = indexOf(root, r.startContainer, r.startOffset)
    const end = indexOf(root, r.endContainer, r.endOffset)
    return start === null || end === null ? null : { start: Math.min(start, end), end: Math.max(start, end) }
  }

  function select(at: { start: number; end: number }) {
    const root = ref.current
    const sel = window.getSelection()
    if (!root || !sel) return
    const r = document.createRange()
    r.setStart(...pointAt(root, at.start))
    r.setEnd(...pointAt(root, at.end))
    sel.removeAllRanges()
    sel.addRange(r)
  }

  /** Draws `runs` (the model's when absent), keeping the selection when the editor has the focus. */
  function paint(runs = model.current.runs) {
    const root = ref.current
    if (!root) return
    const focused = document.activeElement === root
    const at = focused ? selection() : null
    root.replaceChildren()
    for (const r of runs) {
      const span = document.createElement('span')
      span.textContent = r.t
      paintRun(span, r, own)
      root.appendChild(span)
    }
    root.appendChild(document.createElement('br'))
    if (at) select(at)
  }

  /** Whether the DOM is exactly what `paint` would draw for the model. */
  function painted(): boolean {
    const root = ref.current
    if (!root) return true
    const kids = root.childNodes
    const runs = model.current.runs
    if (kids.length !== runs.length + 1 || kids[kids.length - 1].nodeName !== 'BR') return false
    return runs.every((r, i) => {
      const k = kids[i]
      return k.nodeName === 'SPAN' && k.childNodes.length === 1 && k.firstChild?.nodeType === Node.TEXT_NODE && (k.firstChild as Text).data === r.t
    })
  }

  function reportRange() {
    const { styled: can, onRangeStyle: report } = latest.current
    const at = range.current
    report?.(can && at ? rangeStyle(model.current.runs, at.start, at.end, own) : null)
  }

  function trackSelection() {
    if (!ref.current || document.activeElement !== ref.current) return
    const at = selection()
    caret.current = at
    range.current = at && at.end > at.start ? at : null
    reportRange()
  }

  /** Keeps the model as it is now as an undo step; typing close together is one step. */
  function remember(typing = false) {
    const h = history.current
    const now = Date.now()
    const joins = typing && h.typedAt > 0 && now - h.typedAt < TYPING_JOIN_MS
    h.typedAt = typing ? now : 0
    h.future = []
    if (joins) return
    h.past.push({ ...model.current, sel: caret.current })
    if (h.past.length > HISTORY_CAP) h.past.shift()
  }

  /** Undo (`back`) or redo inside the edit; nothing when there is no step. */
  function stepHistory(back: boolean) {
    const h = history.current
    const snap = (back ? h.past : h.future).pop()
    if (!snap) return
    ;(back ? h.future : h.past).push({ ...model.current, sel: caret.current ?? selection() })
    h.typedAt = 0
    const changed = snap.text !== model.current.text
    model.current = { text: snap.text, runs: snap.runs }
    paint()
    const end = snap.text.length
    select(snap.sel ? { start: Math.min(snap.sel.start, end), end: Math.min(snap.sel.end, end) } : { start: end, end })
    if (changed) latest.current.onChange(snap.text)
    trackSelection()
  }

  /** The model takes the text the DOM now holds; runs follow the edit. */
  function readBack() {
    const root = ref.current
    if (!root || composing.current) return
    const next = readText(root)
    const before = model.current.text
    if (next !== before) {
      remember(true)
      const at = selection()?.end
      const { start, end, insert } = diffEdit(before, next, at)
      model.current = { text: next, runs: spliceRuns(model.current.runs, start, end, insert) }
      latest.current.onChange(next)
    }
    if (!painted()) paint()
    trackSelection()
  }

  /** Replaces the selection with `insert` through the model (paste, newline). */
  function insertText(insert: string) {
    const at = selection() ?? { start: model.current.text.length, end: model.current.text.length }
    remember()
    const { text, runs } = model.current
    model.current = { text: text.slice(0, at.start) + insert + text.slice(at.end), runs: spliceRuns(runs, at.start, at.end, insert) }
    latest.current.onChange(model.current.text)
    paint()
    select({ start: at.start + insert.length, end: at.start + insert.length })
    trackSelection()
  }

  function applyStyle(patch: RunPatch) {
    const at = range.current
    const clean = cleanPatch(patch)
    if (!latest.current.styled || !at || Object.keys(clean).length === 0) return
    const { text, runs } = model.current
    const next = normalizeRuns(styleRange(runs, at.start, at.end, clean), own)
    if (encodeRuns(next) === encodeRuns(normalizeRuns(runs, own))) return paint()
    remember()
    model.current = { text, runs: next }
    paint()
    written.current = { text, runs: encodeRuns(next) }
    // Written relative to the element as this edit last left it; a style the
    // write moves onto the element is the base of the next one.
    const rel = rebaseRuns(next, own, wrote.current)
    latest.current.onWrite?.(text, rel, wrote.current)
    wrote.current = liftShared(rel, wrote.current).base
    reportRange()
  }

  function previewStyle(patch: RunPatch | null) {
    const at = range.current
    paint(patch && at ? styleRange(model.current.runs, at.start, at.end, patch) : undefined)
  }

  useImperativeHandle(handleRef, () => ({ range: () => range.current, applyStyle, previewStyle }), [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    paint()
    el.focus()
    select({ start: 0, end: model.current.text.length })
    trackSelection()

    const onSelectionChange = () => trackSelection()
    // The browser's own formatting (and its paragraphs) are not the text's.
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType.startsWith('format')) e.preventDefault()
      else if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault()
        stepHistory(e.inputType === 'historyUndo')
      } else if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
        e.preventDefault()
        insertText('\n')
      }
    }
    // A press away from the editor and the controls that keep it ends the edit,
    // also when the focus has already left it (for the colour panel).
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target
      keepPress.current = (t instanceof Node && el.contains(t)) || inKeepZone(t)
      if (!keepPress.current && document.activeElement !== el) settle()
    }
    document.addEventListener('selectionchange', onSelectionChange)
    el.addEventListener('beforeinput', onBeforeInput)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      el.removeEventListener('beforeinput', onBeforeInput)
      window.removeEventListener('pointerdown', onPointerDown, true)
      latest.current.onRangeStyle?.(null)
    }
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.minHeight = `${rect.height}px`
  }, [rect.height])

  // Commit when the text or its runs changed since the last write, otherwise
  // just close: an unchanged edit must not record an empty undo step.
  function settle() {
    if (settled.current) return
    settled.current = true
    // Ended in the middle of a composition: the composed text is the person's.
    if (composing.current) {
      composing.current = false
      readBack()
    }
    const { text, runs } = model.current
    if (text === written.current.text && encodeRuns(normalizeRuns(runs, own)) === written.current.runs) latest.current.onCancel()
    else latest.current.onCommit(text, rebaseRuns(runs, own, wrote.current), wrote.current)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // The editor's keys are its own: none reach the canvas's shortcuts.
    e.stopPropagation()
    // An IME's keys (the Enter or Esc that confirms a composition) are the IME's.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (matchesUndo(e.nativeEvent) || matchesRedo(e.nativeEvent)) {
      // The edit's own undo; the editor-wide one waits until the edit ends.
      e.preventDefault()
      stepHistory(matchesUndo(e.nativeEvent))
    } else if (e.key === 'Escape') {
      // Esc keeps what was typed, exactly like a click away.
      e.preventDefault()
      settle()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Shift+Enter is a newline; bare Enter commits the text.
      if (e.shiftKey) insertText('\n')
      else settle()
    } else if ((e.metaKey || e.ctrlKey) && !e.altKey && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      // Cmd+B, I or U style the selected range; never the browser's own markup.
      e.preventDefault()
      const at = range.current
      if (!at || !latest.current.styled) return
      const now = rangeStyle(model.current.runs, at.start, at.end, own)
      const k = e.key.toLowerCase() as 'b' | 'i' | 'u'
      const on = k === 'b' ? now.bold : k === 'i' ? now.italic : now.underline
      applyStyle({ [k]: on ? 0 : 1 })
    }
  }

  function handleBlur(e: React.FocusEvent<HTMLDivElement>) {
    const keep = keepPress.current || inKeepZone(e.relatedTarget)
    keepPress.current = false
    if (!keep) settle()
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
    if (text) insertText(text)
  }

  function stopProp(e: React.SyntheticEvent) {
    e.stopPropagation()
  }

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label="Edit text"
      contentEditable
      suppressContentEditableWarning
      onInput={readBack}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false; readBack() }}
      onKeyDown={handleKeyDown}
      onKeyUp={trackSelection}
      onMouseUp={trackSelection}
      onBlur={handleBlur}
      onPaste={handlePaste}
      onDrop={(e) => e.preventDefault()}
      onPointerDown={stopProp}
      onPointerMove={stopProp}
      onClick={stopProp}
      style={{
        ...(styleSnapshot as React.CSSProperties),
        position: 'absolute',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        background: 'transparent',
        outline: 'none',
        padding: '0',
        border: 'none',
        overflow: 'hidden',
        boxSizing: 'content-box',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        cursor: 'text',
        zIndex: 25,
        pointerEvents: 'auto',
      }}
    />
  )
}
