// GENERATED FROM schema/enums.yaml — DO NOT EDIT BY HAND.
// Run `python3 scripts/gen_types.py` after editing the YAML source.

export const PROJECT_TYPES = ['editing', 'music_video', 'ai_video'] as const
export type ProjectType = typeof PROJECT_TYPES[number]
export const DEFAULT_PROJECT_TYPE: ProjectType = 'editing'

export function isProjectType(value: unknown): value is ProjectType {
  return typeof value === 'string' && (PROJECT_TYPES as readonly string[]).includes(value)
}

export function normalizeProjectType(value: unknown): ProjectType {
  if (value === null || value === undefined) return DEFAULT_PROJECT_TYPE
  if (isProjectType(value)) return value
  // eslint-disable-next-line no-console
  console.warn(
    `Unknown project_type ${JSON.stringify(value)} — falling back to ${DEFAULT_PROJECT_TYPE}. ` +
    `Valid values: ${PROJECT_TYPES.join(', ')}`,
  )
  return DEFAULT_PROJECT_TYPE
}

export const PROJECT_STATUSES = ['pending', 'storyboard_ready', 'draft', 'final'] as const
export type ProjectStatus = typeof PROJECT_STATUSES[number]
export const DEFAULT_PROJECT_STATUS: ProjectStatus = 'pending'

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value)
}
