/**
 * Shortcut labels that follow the platform. Source data (keymap hints, Tooltip
 * `keys`) is written with the Mac glyphs ⌘ ⌥ ⇧; these helpers turn them into
 * Ctrl / Alt / Shift when the editor is not running on an Apple platform.
 * Matching already accepts Ctrl or ⌘ everywhere, so only the labels differ.
 */

interface NavigatorLike {
  userAgentData?: { platform?: string }
  platform?: string
  userAgent?: string
}

const APPLE = /mac|iphone|ipad|ipod/i

/** True on macOS and iOS. Unknown or no navigator counts as not Apple (Ctrl). */
export function isApplePlatform(nav: NavigatorLike | undefined = globalThis.navigator): boolean {
  if (!nav) return false
  const hint = nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
  return APPLE.test(hint)
}

/** One key: ⌘ / ⌥ / ⇧ become Ctrl / Alt / Shift off Apple. Anything else is unchanged. */
export function modifierKey(key: string, apple: boolean = isApplePlatform()): string {
  if (apple) return key
  switch (key) {
    case '⌘': return 'Ctrl'
    case '⌥': return 'Alt'
    case '⇧': return 'Shift'
    default: return key
  }
}

export function modifierKeys(keys: readonly string[], apple: boolean = isApplePlatform()): string[] {
  return keys.map((k) => modifierKey(k, apple))
}

/** Text form for a `title` or a sentence: `⌘⇧Z` on Apple, `Ctrl+Shift+Z` elsewhere. */
export function shortcutText(keys: readonly string[], apple: boolean = isApplePlatform()): string {
  return modifierKeys(keys, apple).join(apple ? '' : '+')
}

/** Converts modifier glyphs inside a sentence, e.g. "(⇧ for ten frames)". */
export function modifierLabel(text: string, apple: boolean = isApplePlatform()): string {
  return text.replace(/[⌘⌥⇧]/g, (g) => modifierKey(g, apple))
}
