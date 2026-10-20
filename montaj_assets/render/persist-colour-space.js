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
// (lib/project_lock.py) is flock-based, so this cannot take it. The rename
// puts back the copy read just before, so a write that lands between the
// re-read and the rename (a human edit or an AI save through serve) is
// ERASED, not merely delayed. The window is the read, stringify, temp write
// and rename: milliseconds for a large project, not microseconds. It is
// narrowed, not closed, by comparing project.json's size, mtime and inode
// just before the rename and skipping the rename when any changed (a write
// inside the last few microseconds still slips through). The follow-up that
// closes it: let serve save the detected value under its own project lock.
//
// Temp name matches lib/project_lock.write_json_atomic:
// project.json.<pid>.<hex>.tmp, so serve's temp sweep recognises it.
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'fs'
import { randomBytes } from 'crypto'

const NOOP_LOG = () => {}

export function persistColorSpace(absProjectPath, colorSpace, { fsImpl, log = NOOP_LOG } = {}) {
  const fs = { readFileSync, writeFileSync, renameSync, unlinkSync, statSync, ...(fsImpl ?? {}) }
  const tmp = `${absProjectPath}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`
  let tmpMade = false
  let step = 'read'
  const ident = (st) => `${st.size}:${st.mtimeMs}:${st.ino}`
  try {
    // Fresh read: the in-memory project has absolute srcs and must not be
    // serialised; and the file may have changed since detection.
    const before = ident(fs.statSync(absProjectPath))
    const raw = JSON.parse(fs.readFileSync(absProjectPath, 'utf8'))
    const current = raw.settings?.colorSpace
    if (current != null && current !== '') return { written: false }
    raw.settings = { ...(raw.settings ?? {}), colorSpace }
    const text = JSON.stringify(raw, null, 2)
    tmpMade = true
    step = 'write'
    fs.writeFileSync(tmp, text)
    if (ident(fs.statSync(absProjectPath)) !== before) {
      fs.unlinkSync(tmp)
      tmpMade = false
      log('project.json changed while the colorSpace write-back was prepared; skipped it, the next render detects it again')
      return { written: false, reason: 'changed' }
    }
    step = 'rename'
    fs.renameSync(tmp, absProjectPath)
    tmpMade = false
    return { written: true }
  } catch (e) {
    if (tmpMade) { try { fs.unlinkSync(tmp) } catch { /* already gone */ } }
    let msg
    if (step === 'rename' && e?.code === 'EPERM') msg = 'could not replace project.json (in use)'
    else if (step === 'write' && ['EROFS', 'EACCES'].includes(e?.code)) msg = 'could not write colorSpace back to project.json (project folder is read-only)'
    else msg = `could not write colorSpace back to project.json (${e?.message ?? String(e)})`
    log(`${msg}; continuing, the next render detects it again`)
    return { written: false, error: e }
  }
}
