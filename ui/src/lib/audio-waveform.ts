import { api } from './api'
import type { AudioTrack } from './types/schema'

const WAVEFORM_CHUNK_DURATION_S = 15

export interface WaveformChunk {
  path: string
  start: number
  end: number
}

const cache = new Map<string, Promise<WaveformChunk[]>>()

export function ensureWaveformChunks(track: AudioTrack, projectId: string): Promise<WaveformChunk[]> {
  const key = `${projectId}:${track.id}:${track.src}:${WAVEFORM_CHUNK_DURATION_S}`
  if (cache.has(key)) return cache.get(key)!

  const promise = (async () => {
    const outDir = `.cache/waveforms/${track.id}`
    const chunks = await api.runStep<WaveformChunk[]>('waveform_image', {
      input: track.src,
      'chunk-duration': WAVEFORM_CHUNK_DURATION_S,
      'out-dir': outDir,
    })
    return chunks
  })()

  cache.set(key, promise)
  return promise
}

export function invalidateWaveform(track: AudioTrack, projectId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${projectId}:${track.id}:`)) cache.delete(k)
  }
}
