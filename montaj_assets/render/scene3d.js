/**
 * scene3d.js (§239): a 3D scene item is an overlay item whose `src` is the reserved `engine:scene3d`:
 *
 *   { "type": "overlay", "src": "engine:scene3d", "start": 12, "end": 16.5,
 *     "props": { "scene": "hands", "inPoint": 2 } }
 *
 * `materializeScene3d` turns each one into the plain overlay every other part of the render already knows, in
 * place and before anything else reads the project: `src` becomes the stage the HOST supplies
 * (`MONTAJ_SCENE3D_STAGE`, an absolute path to a stage .jsx: the app keeps the freshest one in its runtime home),
 * and `props` gain `sceneFile` (the scene's active.json, an absolute path, which travels to the page as a file URL and
 * is read there) and `inPoint` (seconds into the scene's own timeline). From then on the bundle, the read boundary,
 * the sample cache's input manifest (it records props file paths, so an edited scene misses) and the segment encoder
 * need to know nothing about scenes.
 *
 * `scene` names a folder under `<project>/models/scenes/<name>/`; absent is the project's single scene,
 * `<project>/models/active.json` (what the model-3d template's overlay copy imports today). A missing stage or scene
 * is an error that names it, never a blank frame. A second pass finds nothing left to do.
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { trackItems } from './project-tracks.js'

export const SCENE3D_SRC = 'engine:scene3d'
export const SCENE3D_STAGE_ENV = 'MONTAJ_SCENE3D_STAGE'
const SCENE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** An error with a stable `code`, for the CLI's JSON failure line. */
export class Scene3dError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export const isScene3dItem = (item) => !!item && item.type === 'overlay' && item.src === SCENE3D_SRC

/** The stage the host supplies, or a Scene3dError saying how to get one. */
export function scene3dStage({ env = process.env, exists = existsSync } = {}) {
  const stage = env[SCENE3D_STAGE_ENV]
  if (typeof stage !== 'string' || stage.length === 0 || !exists(stage)) {
    throw new Scene3dError(
      'scene3d_stage_unavailable',
      `A 3D scene item needs the 3D stage, and this Montaj has none (${SCENE3D_STAGE_ENV} ${stage ? `points at a missing file: ${stage}` : 'is not set'}). Update the Montaj app.`,
    )
  }
  return stage
}

/**
 * Rewrites every scene item of `project` into a plain overlay item. `projectDir` is the folder holding project.json.
 * Throws Scene3dError (`scene3d_stage_unavailable`, `scene3d_scene_missing`, `scene3d_invalid`) naming the item.
 * Returns how many items it rewrote.
 */
export function materializeScene3d(project, projectDir, { env = process.env, exists = existsSync } = {}) {
  let n = 0
  for (const track of trackItems(project)) {
    for (const item of track ?? []) {
      if (!isScene3dItem(item)) continue
      const label = item.id ? `scene item "${item.id}"` : 'a scene item'
      if (typeof projectDir !== 'string' || projectDir.length === 0) {
        throw new Scene3dError('scene3d_invalid', `${label} needs the project's folder to find its scene.`)
      }
      const props = item.props && typeof item.props === 'object' && !Array.isArray(item.props) ? item.props : {}
      const name = props.scene
      if (name !== undefined && (typeof name !== 'string' || !SCENE_NAME.test(name))) {
        throw new Scene3dError('scene3d_invalid', `${label}: scene must be a name of lowercase letters, digits, - and _ (got ${JSON.stringify(name)}).`)
      }
      const inPoint = props.inPoint === undefined ? 0 : props.inPoint
      if (typeof inPoint !== 'number' || !Number.isFinite(inPoint) || inPoint < 0) {
        throw new Scene3dError('scene3d_invalid', `${label}: inPoint must be 0 or more seconds (got ${JSON.stringify(props.inPoint)}).`)
      }
      const stage = scene3dStage({ env, exists })
      const sceneFile = name === undefined ? join(projectDir, 'models', 'active.json') : join(projectDir, 'models', 'scenes', name, 'active.json')
      if (!exists(sceneFile)) {
        throw new Scene3dError('scene3d_scene_missing', `${label}: the scene ${name === undefined ? '(the project\'s own)' : `"${name}"`} has no ${sceneFile}. Save the scene first.`)
      }
      item.src = stage
      item.props = { ...props, sceneFile, inPoint }
      n += 1
    }
  }
  return n
}
