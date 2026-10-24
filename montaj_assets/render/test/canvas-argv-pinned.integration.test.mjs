// The ffmpeg argv of the three black canvases §563 put a size/fps check on: sampleRawFrame's black frame,
// sampleFrame's composite canvas and the NLE graphics canvas. Recorded through a wrapper ffmpeg (which logs its argv
// and runs the real one) and pinned to what montaj built BEFORE the checks (9e4ab896): valid projects keep every byte.
// Temp paths read <tmp>, a random temp-folder suffix XXXXXX, a filter script SCRIPT:<its contents>.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { FFMPEG } from '../ffmpeg-bin.js'

const renderDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasFfmpeg = spawnSync(FFMPEG, ['-version']).status === 0

function captureCanvasArgv(renderDir, realFfmpeg) {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-argv-'))
  const log = join(dir, 'argv.log')
  const wrapper = join(dir, 'ffmpeg')
  writeFileSync(wrapper, `#!${process.execPath}
const { appendFileSync, readFileSync } = require('fs')
const { spawnSync } = require('child_process')
const args = process.argv.slice(2)
const shown = args.map((a, i) => (i > 0 && args[i - 1].startsWith('-/') ? 'SCRIPT:' + readFileSync(a, 'utf8') : a))
appendFileSync(${JSON.stringify(log)}, JSON.stringify(shown) + '\\n')
process.exit(spawnSync(${JSON.stringify(realFfmpeg)}, args, { stdio: 'inherit' }).status ?? 1)
`)
  chmodSync(wrapper, 0o755)
  const code = `
    const { sampleFrame, sampleRawFrame } = await import(${JSON.stringify(join(renderDir, 'sample-frame.js'))})
    const project = { settings: { resolution: [64, 48], fps: 10 }, tracks: [] }
    await sampleRawFrame({ projectJson: project, atSeconds: 0, outPath: ${JSON.stringify(join(dir, 'raw.png'))} })
    await sampleFrame({ projectJson: project, atSeconds: 0, outPath: ${JSON.stringify(join(dir, 'frame.png'))} })
    const { copyFileSync, mkdirSync } = await import('node:fs')
    const { buildNleTimeline } = await import(${JSON.stringify(join(renderDir, 'nle', 'timeline.js'))})
    const { renderNleGraphics } = await import(${JSON.stringify(join(renderDir, 'nle', 'graphics.js'))})
    const projDir = ${JSON.stringify(join(dir, 'proj'))}
    mkdirSync(projDir)
    copyFileSync(${JSON.stringify(join(renderDir, 'test', 'fixtures', 'cadence-ramp.jsx'))}, projDir + '/ramp.jsx')
    const nle = { version: '0.2', id: 'pin', status: 'final', projectType: 'editing',
      settings: { resolution: [320, 180], fps: 30, colorSpace: 'sdr_bt709' },
      tracks: [{ id: 't0', items: [] }, { id: 't1', items: [
        { id: 'ramp', type: 'overlay', src: 'ramp.jsx', props: {}, start: 0, end: 0.2, scale: 0.5 }] }], assets: [] }
    const timeline = buildNleTimeline(nle, { projectDir: projDir })
    await renderNleGraphics(nle, timeline, { projectDir: projDir, outDir: projDir + '/export', workers: 1 })`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { encoding: 'utf8', env: { ...process.env, MONTAJ_FFMPEG: wrapper, TMPDIR: dir } })
  if (r.status !== 0) throw new Error(r.stderr)
  return readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).map(a => a.split(dir).join('<tmp>').replace(/(<tmp>\/[a-z0-9-]+-)[A-Za-z0-9]{6}(?=\/)/g, '$1XXXXXX')))
}

const BEFORE_CHECKS = [["-y","-v","error","-f","lavfi","-i","color=c=black:s=64x48","-frames:v","1","-update","1","<tmp>/raw.png"],["-y","-v","error","-f","lavfi","-i","color=black:size=64x48:rate=10:duration=0.1","-/filter_complex","SCRIPT:[0:v]format=rgba[canvas]","-map","[canvas]","-frames:v","1","-update","1","<tmp>/frame.png"],["-y","-f","image2pipe","-c:v","png","-framerate","30","-i","pipe:0","-c:v","ffv1","-g","1","-pix_fmt","yuva420p","-f","matroska","-cluster_size_limit","2000000","-reserve_index_space","1000000","<tmp>/montaj-nle-graphics-XXXXXX/capture-chunk-0.mkv"],["-y","-v","error","-f","lavfi","-i","color=c=black@0.0:size=320x180:rate=30:duration=0.23333333333333334,format=yuva420p","-ss","0","-t","0.2","-i","<tmp>/montaj-nle-graphics-XXXXXX/capture-chunk-0.mkv","-/filter_complex","SCRIPT:[0:v]format=yuva420p,setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv[canvas];[1:v]format=yuva420p,setpts=N/(30*TB)[ovfmt1];[ovfmt1]scale=160:90:flags=bicubic+accurate_rnd+full_chroma_int:in_color_matrix=bt601:out_color_matrix=bt709:in_range=tv:out_range=tv,setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv[ovsc1];[canvas][ovsc1]overlay=x=80:y=45:format=yuv420:shortest=0[vov1];[vov1]format=yuva444p10le,setparams=colorspace=bt709:color_trc=bt709:color_primaries=bt709:range=tv[vout]","-map","[vout]","-frames:v","6","-r","30","-c:v","prores_ks","-profile:v","4444","-pix_fmt","yuva444p10le","-alpha_bits","16","-vendor","apl0","-color_primaries","bt709","-color_trc","bt709","-colorspace","bt709","-color_range","tv","-an","<tmp>/proj/export/graphics/ramp.mov"]]

// The wrapper is a shebang script, which Windows cannot run.
test('the black canvases build exactly the ffmpeg argv they did before the §563 checks', { skip: !hasFfmpeg || process.platform === 'win32' }, () => {
  assert.deepEqual(captureCanvasArgv(renderDir, FFMPEG), BEFORE_CHECKS)
})
