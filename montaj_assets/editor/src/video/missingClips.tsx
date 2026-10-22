import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { Project } from '../types'
import { enabledTrackItems } from './timeline/timeline-model'

/**
 * Clips whose footage is absent (`VideoEditorProps.missingClips`), shared with
 * the timeline, the preview and the export dialog through one context so no
 * prop has to thread through every layer. The default is an empty set with no
 * notifier, which is what every surface sees when the host passes nothing:
 * behaviour is then exactly what it was before the prop existed.
 */
export interface MissingClipsValue {
  ids: ReadonlySet<string>
  notify?: (notice: { title: string; detail: string }) => void
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>()
const NONE: MissingClipsValue = { ids: EMPTY_IDS }

export const MissingClipsContext = createContext<MissingClipsValue>(NONE)

export function useMissingClips(): MissingClipsValue {
  return useContext(MissingClipsContext)
}

export function MissingClipsProvider({
  ids,
  notify,
  children,
}: {
  ids: ReadonlySet<string> | undefined
  notify: MissingClipsValue['notify']
  children: ReactNode
}) {
  const value = useMemo<MissingClipsValue>(
    () => (ids && ids.size > 0 ? { ids, notify } : { ids: EMPTY_IDS, notify }),
    [ids, notify],
  )
  return <MissingClipsContext.Provider value={value}>{children}</MissingClipsContext.Provider>
}

export interface MissingClipRef {
  id: string
  /** Name to show the user: the file name without its folder. */
  name: string
  start: number
  end: number
}

function fileName(src: string | undefined): string {
  if (!src) return ''
  const base = src.split(/[\\/]/).pop() ?? src
  return base
}

/**
 * The missing clips on ENABLED tracks (the ones playback and export use), in
 * track order. A skipped track never plays or exports, so a clip on it is not
 * blocking anything.
 */
export function enabledMissingClips(
  project: Pick<Project, 'tracks'> | { tracks?: unknown },
  ids: ReadonlySet<string>,
): MissingClipRef[] {
  if (ids.size === 0) return []
  const out: MissingClipRef[] = []
  for (const items of enabledTrackItems(project)) {
    for (const item of items) {
      if (!ids.has(item.id)) continue
      const label = (item as { label?: string }).label
      out.push({
        id: item.id,
        name: label || fileName(item.src) || item.id,
        start: item.start,
        end: item.end,
      })
    }
  }
  return out
}

/** Missing clips that playing from `t` would reach: they end after `t`. */
export function missingClipsAhead(
  project: { tracks?: unknown },
  ids: ReadonlySet<string>,
  t: number,
): MissingClipRef[] {
  return enabledMissingClips(project, ids).filter(c => c.end > t)
}

/** The missing clip under the playhead, if any. */
export function missingClipAt(
  project: { tracks?: unknown },
  ids: ReadonlySet<string>,
  t: number,
): MissingClipRef | null {
  return enabledMissingClips(project, ids).find(c => t >= c.start && t < c.end) ?? null
}

export const MISSING_TITLE = 'Footage missing'

/** One line naming the clips, de-duplicated, for `onError` and the export refusal. */
export function missingDetail(clips: readonly MissingClipRef[]): string {
  return Array.from(new Set(clips.map(c => c.name))).join(', ')
}
