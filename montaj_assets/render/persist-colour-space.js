// montaj_assets/render/persist-colour-space.js
//
// Write a smart-detected settings.colorSpace back to project.json so later
// renders skip detection. The heal is an optimisation, never a requirement:
// nothing here may fail the render.
//
// The write is atomic (a temp file in the same folder, renamed over
// project.json) so a reader never sees a cut-off file, and it re-reads the
// file immediately before writing and does nothing if colorSpace is already
// set, so a project write that landed since detection is not overwritten by
// an old copy.
//
// REMAINING WINDOW: Node has no flock and the Python project lock
// (lib/project_lock.py) is flock-based, so this cannot take it. A write that
// lands between the re-read below and the rename (microseconds) can still be
// lost. The heal only writes when colorSpace is unset, so the loss only means
// the next render detects the colour again.
//
// Temp name matches lib/project_lock.write_json_atomic:
// project.json.<pid>.<hex>.tmp, so serve's temp sweep recognises it.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { randomBytes } from 'crypto'

const NOOP_LOG = () => {}

export function persistColorSpace(absProjectPath, colorSpace, { fsImpl, log = NOOP_LOG } = {}) {
  const fs = { readFileSync, writeFileSync, renameSync, unlinkSync, ...(fsImpl ?? {}) }
  const tmp = `${absProjectPath}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
  let tmpMade = false
  try {
    // Fresh read: the in-memory project has absolute srcs and must not be
    // serialised; and the file may have changed since detection.
    const raw = JSON.parse(fs.readFileSync(absProjectPath, 'utf8'))
    const current = raw.settings?.colorSpace
    if (current != null && current !== '') return { written: false }
    raw.settings = { ...(raw.settings ?? {}), colorSpace }
    tmpMade = true
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2))
    fs.renameSync(tmp, absProjectPath)
    tmpMade = false
    return { written: true }
  } catch (e) {
    if (tmpMade) { try { fs.unlinkSync(tmp) } catch { /* already gone */ } }
    const why = ['EACCES', 'EROFS', 'EPERM'].includes(e?.code) ? 'project folder is read-only' : (e?.message ?? String(e))
    log(`could not write colorSpace back to project.json (${why}); continuing, the next render detects it again`)
    return { written: false, error: e }
  }
}
