import { useEffect, useRef } from 'react'

/**
 * The editor's ONE keydown registry — replaces the racing `document`-level
 * listeners that used to live independently in VideoEditor (split, undo/
 * redo) and Timeline (arrows, delete, enter, escape), each with its own
 * slightly different typing-surface guard. `useKeymap` mounts exactly one
 * `document` keydown listener per call site and evaluates bindings in order;
 * the first whose `matches` + `guard` both pass wins.
 *
 * Space is explicitly OUT OF SCOPE — it stays owned by the playback hooks
 * (`useVideoPlayback`/`useEnginePlayback`, both legacy and engine paths) so
 * this registry can never race them. See the hard-coded check in
 * `useKeymap` below.
 *
 * There are two call sites, mirroring where their bindings' dependencies
 * actually live (see T9's report for the full reasoning):
 *   - Timeline owns arrows/delete/enter/escape — it mounts its own
 *     `useKeymap` with those bindings, in BOTH the pending and review
 *     surfaces (exactly where its old internal listener ran).
 *   - VideoEditor's ReviewSurface owns split/undo/redo plus every new T9
 *     binding (J/K/L shuttle, ripple-delete, command palette) — the
 *     editing-only bindings that only ever lived in the review surface.
 */

/** INPUT / TEXTAREA / any contentEditable host — every migrated binding's
 *  typing-surface guard, ported verbatim from the handlers it replaces.
 *  `!!(...)` coerces to a real boolean: `el.isContentEditable` is a plain
 *  DOM boolean in every real browser, but partial event objects in tests
 *  (and jsdom's incomplete `isContentEditable` support) can leave it
 *  `undefined` — this keeps the guard's return type honest either way. */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement
  return !!(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export interface KeyBinding {
  id: string
  /** Palette label (also the tooltip/description). */
  description: string
  /** Display-only shortcut hint, e.g. ['⌘', 'Z']. Not used for matching. */
  keyHint?: string[]
  /** Whether this keydown event should fire the binding. */
  matches: (e: KeyboardEvent) => boolean
  /** Extra guard beyond the shared base guard (typing surface + modal-open),
   *  e.g. "only when there's a selection" or "only when totalDuration > 0". */
  guard?: () => boolean
  /** Defaults to true. */
  preventDefault?: boolean
  action: (e: KeyboardEvent) => void
  /** Exclude from the command palette — context-only bindings (arrow frame-
   *  step, Enter/Escape marker placement) aren't "commands" you run once. */
  paletteHidden?: boolean
}

export interface UseKeymapOptions {
  /** True while any dialog/palette is open — suppresses every binding. */
  modalOpen?: boolean
}

/**
 * Mounts one `document` keydown listener for the given bindings for the
 * lifetime of the component. Bindings and options are read through refs so
 * the listener's identity never churns — callers can pass fresh closures
 * every render without re-registering.
 */
export function useKeymap(bindings: KeyBinding[], options: UseKeymapOptions = {}) {
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Never owned by the keymap — see file header.
      if (e.code === 'Space' || e.key === ' ') return
      if (isTypingTarget(e)) return
      if (optionsRef.current.modalOpen) return

      for (const binding of bindingsRef.current) {
        if (!binding.matches(e)) continue
        if (binding.guard && !binding.guard()) continue
        if (binding.preventDefault !== false) e.preventDefault()
        binding.action(e)
        return
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}

// ── Combo matchers — small helpers so bindings read declaratively ──────────

const mod = (e: KeyboardEvent) => !!(e.metaKey || e.ctrlKey)

/** Bare letter key, no modifier check — reproduces the original S-to-split
 *  handler's behavior verbatim (it only ever checked `e.key`). */
export function matchesKey(key: string) {
  const lower = key.toLowerCase()
  return (e: KeyboardEvent) => e.key.toLowerCase() === lower
}

/** Letter key with NO modifier held (mod/alt) — used for the new J/K/L
 *  shuttle bindings so they don't fire alongside Cmd/Ctrl/Alt combos. */
export function matchesPlainKey(key: string) {
  const lower = key.toLowerCase()
  return (e: KeyboardEvent) => e.key.toLowerCase() === lower && !mod(e) && !e.altKey
}

export function matchesUndo(e: KeyboardEvent): boolean {
  return mod(e) && e.key.toLowerCase() === 'z' && !e.shiftKey
}

export function matchesRedo(e: KeyboardEvent): boolean {
  return mod(e) && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')
}

export function matchesModKey(key: string) {
  const lower = key.toLowerCase()
  return (e: KeyboardEvent) => mod(e) && e.key.toLowerCase() === lower
}

/** Mod+Alt+key, e.g. Cmd+Opt+V for paste-attributes. NOTE: `matchesModKey`
 *  does NOT exclude `altKey`, so a mod+alt chord matches BOTH this and the
 *  bare mod+key binding for the same letter — whichever binding is
 *  registered FIRST in a `useKeymap` array wins (first match wins), so a
 *  mod+alt binding must always be listed before its mod-only sibling. */
export function matchesModAltKey(key: string) {
  const lower = key.toLowerCase()
  return (e: KeyboardEvent) => mod(e) && e.altKey && e.key.toLowerCase() === lower
}

/** Delete/Backspace WITHOUT Shift — reserves Shift+Delete for ripple-delete. */
export function matchesDelete(e: KeyboardEvent): boolean {
  return (e.key === 'Delete' || e.key === 'Backspace') && !e.shiftKey
}

export function matchesShiftDelete(e: KeyboardEvent): boolean {
  return (e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey
}

export const matchesEscape = matchesKey('Escape')
export const matchesEnter = matchesKey('Enter')
export const matchesArrowLeft = matchesKey('ArrowLeft')
export const matchesArrowRight = matchesKey('ArrowRight')
