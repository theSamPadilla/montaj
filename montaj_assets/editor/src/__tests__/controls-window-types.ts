// Compile-time tripwire for the `renderControls` contract: the four types a
// host needs to draw the Controls window are importable from the package
// index. No runtime here (vitest never collects this file); `tsc --noEmit`
// covers it through tsconfig's `include: ["src"]`.
import type { ReactNode } from 'react'
import { Keyboard } from 'lucide-react'
import type {
  CarouselEditorProps,
  ControlEntry,
  ControlSection,
  ControlsWindowContext,
  ControlsWindowSection,
  VideoEditorProps,
} from '../index'

const entry: ControlEntry = { keys: ['Ctrl', 'Z'], label: 'Undo', where: 'Timeline' }
const plain: ControlSection = { heading: 'Keyboard', entries: [entry] }
const section: ControlsWindowSection = { ...plain, icon: Keyboard }

export const ctx: ControlsWindowContext = {
  open: true,
  title: 'Editor controls',
  kind: 'carousel',
  sections: [section],
  onClose: () => {},
}

const draw = (c: ControlsWindowContext): ReactNode =>
  c.open ? c.sections.map((s) => `${s.heading}: ${s.entries.map((e) => e.label).join(', ')}`) : null

export const videoHook: VideoEditorProps['renderControls'] = draw
export const carouselHook: CarouselEditorProps['renderControls'] = draw

// @ts-expect-error a window section without its icon is not one
export const missingIcon: ControlsWindowSection = plain
