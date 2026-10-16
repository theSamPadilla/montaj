/**
 * scene3d.js (§239): a 3D scene item is an overlay item whose `src` is the reserved `engine:scene3d`:
 *
 *   { "type": "overlay", "src": "engine:scene3d", "start": 12, "end": 16.5,
 *     "props": { "scene": "hands", "inPoint": 2 } }
 *
 * `materializeScene3d` turns each one into the plain overlay every other part of the render already knows, in
 * place and before anything else reads the project: `src` becomes the stage the HOST supplies
 * (`MONTAJ_SCENE3D_STAGE`, an absolute path to a stage .jsx: the app keeps the freshest one in its runtime home),
 * and `props` gain `sceneFile` (the scene's active.json, an absolute path: it travels to the page as a file URL and is
 * what the sample cache's manifest records), `sceneJson` (that file's text, read and checked here, so the stage draws from
 * the page's first render and an unreadable scene fails the render instead of drawing blank; one string, so the
 * props scanners (path rewriting, the read boundary, named URLs) see one value and not every string of the scene) and `inPoint` (seconds
 * into the scene's own timeline). From then on the bundle, the read boundary,
 * the sample cache's input manifest (it records props file paths, so an edited scene misses) and the segment encoder
 * need to know nothing about scenes.
 *
 * `scene` names a folder under `<project>/models/scenes/<name>/`; absent is the project's single scene,
 * `<project>/models/active.json` (what the model-3d template's overlay copy imports today). A missing stage or scene
 * is an error that names it, never a blank frame. A second pass finds nothing left to do.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { trackItems } from './project-tracks.js'

export const SCENE3D_SRC = 'engine:scene3d'
export const SCENE3D_STAGE_ENV = 'MONTAJ_SCENE3D_STAGE'
// The same rule save_model and the preview use (a folder made by hand with any other name would export and not preview).
const SCENE_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/

/** An error with a stable `code`, for the CLI's JSON failure line. */
export class Scene3dError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export const isScene3dItem = (item) => !!item && item.type === 'overlay' && item.src === SCENE3D_SRC

/** Where a missing stage is named: the log, never the message (its path can say "scene"). */
const logToStderr = (line) => process.stderr.write(`${line}\n`)

/**
 * The stage the host supplies, or a Scene3dError saying how to get one. The message is the same whether the variable is
 * unset or names a missing file; which of the two, and the path, go to `log` (stderr) for whoever debugs the host.
 */
export function scene3dStage({ env = process.env, exists = existsSync, log = logToStderr } = {}) {
  const stage = env[SCENE3D_STAGE_ENV]
  if (typeof stage !== 'string' || stage.length === 0 || !exists(stage)) {
    log(`[montaj] the 3D stage is unavailable: ${SCENE3D_STAGE_ENV} ${stage ? `names a missing file: ${stage}` : 'is not set'}`)
    throw new Scene3dError('scene3d_stage_unavailable', 'A 3D item needs the 3D stage, and this Montaj has none. Update the Montaj app.')
  }
  return stage
}

/**
 * Rewrites every scene item of `project` into a plain overlay item. `projectDir` is the folder holding project.json.
 * Throws Scene3dError (`scene3d_stage_unavailable`, `scene3d_scene_missing`, `scene3d_invalid`) naming the item.
 * Returns how many items it rewrote.
 *
 * The messages reach whoever exports, so they say "3D" and never "scene": the user never meets that concept (§308).
 * The codes keep their names; they are for the host and the AI.
 */
export function materializeScene3d(project, projectDir, { env = process.env, exists = existsSync, read = (f) => readFileSync(f, 'utf8'), log = logToStderr } = {}) {
  let n = 0
  for (const track of trackItems(project)) {
    for (const item of track ?? []) {
      if (!isScene3dItem(item)) continue
      const label = item.id ? `3D item "${item.id}"` : 'A 3D item'
      if (typeof projectDir !== 'string' || projectDir.length === 0) {
        throw new Scene3dError('scene3d_invalid', `${label} needs the project's folder to find its 3D.`)
      }
      const props = item.props && typeof item.props === 'object' && !Array.isArray(item.props) ? item.props : {}
      const name = props.scene
      if (name !== undefined && (typeof name !== 'string' || !SCENE_NAME.test(name))) {
        throw new Scene3dError('scene3d_invalid', `${label}: its 3D must be named with lowercase letters, digits and - (got ${JSON.stringify(name)}).`)
      }
      const which = name === undefined ? 'the project\'s own 3D' : `its 3D "${name}"`
      const inPoint = props.inPoint === undefined ? 0 : props.inPoint
      if (typeof inPoint !== 'number' || !Number.isFinite(inPoint) || inPoint < 0) {
        throw new Scene3dError('scene3d_invalid', `${label}: inPoint must be 0 or more seconds (got ${JSON.stringify(props.inPoint)}).`)
      }
      const stage = scene3dStage({ env, exists, log })
      const sceneFile = name === undefined ? join(projectDir, 'models', 'active.json') : join(projectDir, 'models', 'scenes', name, 'active.json')
      if (!exists(sceneFile)) {
        throw new Scene3dError('scene3d_scene_missing', `${label}: ${which} is not saved yet.`)
      }
      let sceneJson, sceneData
      try {
        sceneJson = read(sceneFile)
        sceneData = JSON.parse(sceneJson)
      } catch (e) {
        // A read error's code, not its message: the message carries the file's path, which names the scenes folder.
        const why = e && typeof e.code === 'string' ? e.code : (e && e.message ? e.message : e)
        throw new Scene3dError('scene3d_invalid', `${label}: ${which} cannot be read (${why}).`)
      }
      if (!sceneData || typeof sceneData !== 'object' || Array.isArray(sceneData) || !sceneData.model || typeof sceneData.model !== 'object') {
        throw new Scene3dError('scene3d_invalid', `${label}: ${which} has no model in it.`)
      }
      item.src = stage
      item.props = { ...props, sceneFile, sceneJson, inPoint }
      n += 1
    }
  }
  return n
}
