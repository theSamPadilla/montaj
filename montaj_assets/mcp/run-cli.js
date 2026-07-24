import { spawn } from 'node:child_process'

/**
 * Async replacement for the CallTool spawnSync. Resolves (never rejects) with
 * a spawnSync-shaped result: { status, signal, stdout, stderr, error? } so the
 * caller's existing error branches keep working.
 */
export function runCli(command, argv, { timeoutMs, cwd, env } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, argv, { cwd, env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; proc.kill('SIGTERM') }, timeoutMs)
      : null
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    proc.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolve({ status: null, signal: null, stdout, stderr, error })
    })
    proc.on('close', (status, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ status, signal: timedOut ? 'SIGTERM' : signal, stdout, stderr })
    })
  })
}
