import type { EditorProject, AudioTrack } from '../schema'

/**
 * The audio track a selected id names, or null. A project can carry `audio: {}`
 * with no `tracks` list, and the selection holds ids that are no track at all
 * (a marker's, once a click on the marker strip selects it), so both reads are
 * guarded: this runs on every render with a selection.
 */
export function selectedAudioTrack(project: EditorProject, id: string | null): AudioTrack | null {
  if (!id) return null
  return project.audio?.tracks?.find(t => t.id === id) ?? null
}
