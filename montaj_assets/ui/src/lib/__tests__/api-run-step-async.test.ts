import { describe, it, expect, beforeEach, vi } from 'vitest'
import { api } from '../api'

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  }
}

beforeEach(() => vi.unstubAllGlobals())

describe('api.runStepAsync', () => {
  it('POSTs with _async and polls the job until done, returning result', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ job_id: 'j1', status: 'running' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'running' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'done', result: { path: '/out.png' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.runStepAsync<{ path: string }>(
      'generate_image', { prompt: 'x', out: '/out.png' }, { pollMs: 1 },
    )
    expect(result).toEqual({ path: '/out.png' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/steps/generate_image')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(
      { prompt: 'x', out: '/out.png', _async: true },
    )
    expect(fetchMock.mock.calls[1][0]).toBe('/api/steps/jobs/j1')
  })

  it('throws the job error message on status error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ job_id: 'j2', status: 'running' }, 202))
      .mockResolvedValueOnce(jsonResponse({
        status: 'error', error: { error: 'step_failed', message: 'ffmpeg exploded' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      api.runStepAsync('waveform_image', { input: '/a.mp4' }, { pollMs: 1 }),
    ).rejects.toThrow('ffmpeg exploded')
  })

  it('rejects when the job outlives timeoutMs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ job_id: 'j3', status: 'running' }, 202))
      .mockResolvedValue(jsonResponse({ status: 'running' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      api.runStepAsync('waveform_image', { input: '/a.mp4' }, { pollMs: 1, timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/)
  })

  it('surfaces a 404 job_not_found (e.g. server restarted mid-job)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ job_id: 'j4', status: 'running' }, 202))
      .mockResolvedValueOnce(jsonResponse(
        { detail: { error: 'job_not_found', message: "Job 'j4' not found" } }, 404,
      ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      api.runStepAsync('generate_image', { prompt: 'x' }, { pollMs: 1 }),
    ).rejects.toThrow("Job 'j4' not found")
  })
})
