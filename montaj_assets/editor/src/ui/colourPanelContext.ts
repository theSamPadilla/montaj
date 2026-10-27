import { createContext } from 'react'

// The rail layout's colour panel (§587 M5). A colour control that finds this
// context opens the panel instead of the OS picker; with no provider (the
// classic layout, the video editor) it keeps the native picker.

export interface ColourRequest {
  /** The panel header: what is being coloured. */
  label: string
  /** The colour now (`#rrggbb` or `#rrggbbaa`, or any CSS colour the control holds). */
  value: string
  /** Whether the target takes an 8-digit hex (shows the transparency controls). */
  alpha?: boolean
  /** Shows a live preview of a pick. Absent: the control has none. */
  preview?: (value: string) => void
  /** Writes the pick: once. */
  commit: (value: string) => void
  /** Gives an uncommitted preview up (after `preview(value)` put the old colour back). */
  cancel?: () => void
  /** What is coloured: an element (default; a locked one keeps its colour) or the slide itself. */
  target?: 'element' | 'slide'
}

export type OpenColourPanel = (request: ColourRequest) => void

export const ColourPanelContext = createContext<OpenColourPanel | null>(null)
