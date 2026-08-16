/**
 * SP4 T7 — the debug HUD: fps / dropped / buffered / clock-kind, live,
 * rendered only behind `engine.debugHud`.
 *
 * Precedent: `spikes/playback-engine/src/hud.ts`'s `mountPlaybackHud` — the
 * same four numbers (painted fps over a rolling window, drops, decode-ahead
 * buffer depth, which clock is driving), read the same way (a rolling
 * window, never a single instantaneous sample). Deliberately NOT that file:
 * no per-(source, hardwareAcceleration) bucket matrix, no JSON export
 * button, no memory probe, no `window.__playbackHud` console handle — this
 * is a production affordance for "is the engine keeping up right now", not
 * the spike's benchmarking instrument. One engine, one bucket.
 *
 * Polls `Engine.stats()` (via the stable `getStats` the facade/hook exposes)
 * on its own timer rather than subscribing to engine status: `EngineStatus`
 * only republishes on a genuine transport/picture/clip/clock CHANGE
 * (`scheduler.ts`'s `publish`), so fps/buffer — which move on every painted
 * frame while playing — would sit stale between those events if this
 * component keyed off status instead.
 */
import { useEffect, useState } from 'react'
import type { EngineStats } from './index'

/** 2Hz — fast enough to read as "live" without re-rendering on every paint. */
const POLL_MS = 500

interface DebugHudProps {
  getStats: () => EngineStats | null
}

function fmtNum(v: number | undefined, digits = 0): string {
  return v === undefined ? 'n/a' : v.toFixed(digits)
}

export default function DebugHud({ getStats }: DebugHudProps) {
  const [stats, setStats] = useState<EngineStats | null>(() => getStats())

  useEffect(() => {
    const id = setInterval(() => setStats(getStats()), POLL_MS)
    return () => clearInterval(id)
  }, [getStats])

  return (
    <div
      className="montaj-engine-debug-hud absolute bottom-2 left-2 select-none rounded bg-black/70 px-2 py-1 font-mono text-[10px] leading-tight text-white/80 pointer-events-none"
      style={{ zIndex: 3 }}
    >
      <div>fps {fmtNum(stats?.fps, 1)}</div>
      <div>dropped {fmtNum(stats?.dropped)}</div>
      <div>buffered {fmtNum(stats?.buffered)}</div>
      <div>clock {stats?.clock ?? 'n/a'}</div>
    </div>
  )
}
