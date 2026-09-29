// Resolver for ffmpeg/ffprobe binaries, in the same order as Python's
// lib/common.py _resolve_av_bin: env override -> the montaj-managed static
// build -> bare PATH name. Python threads the managed path through
// MONTAJ_FFMPEG / MONTAJ_FFPROBE for every render child it spawns, so in
// production the env always wins. The managed fallback is for a direct
// `node --test` or CLI run with no env: without it, those silently got
// whatever ffmpeg PATH found (Homebrew's has no zscale), while the code under
// test would have used the managed build (PV52).
import { accessSync, constants } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// lib/models.py MONTAJ_MODELS_DIR + "ffmpeg" (a directory; the binaries are inside).
const MANAGED_DIR = join(homedir(), '.local', 'share', 'montaj', 'models', 'ffmpeg')
const EXE = process.platform === 'win32' ? '.exe' : ''

function managed(name) {
  const p = join(MANAGED_DIR, name + EXE)
  try { accessSync(p, constants.X_OK); return p } catch { return null }
}

export const FFMPEG = process.env.MONTAJ_FFMPEG || managed('ffmpeg') || 'ffmpeg';
export const FFPROBE = process.env.MONTAJ_FFPROBE || managed('ffprobe') || 'ffprobe';
