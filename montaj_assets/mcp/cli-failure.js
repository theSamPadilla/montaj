const TAIL = 2000

const tail = (s) => {
  const t = (s || '').trim()
  return t.length > TAIL ? t.slice(-TAIL) : t
}

/**
 * Text returned to the agent when a CLI tool call fails (non-zero exit or a
 * non-timeout signal kill). Says how the process ended, plus the tail of
 * stderr, or of stdout when stderr is empty.
 */
export function cliFailureMessage(name, result) {
  const err = tail(result.stderr)
  const out = err ? '' : tail(result.stdout)
  const body = {
    error: 'cli_failed',
    tool: name,
    exit: result.status ?? null,
    signal: result.signal ?? null,
    message: result.status == null
      ? `Tool '${name}' was killed by ${result.signal || 'an unknown signal'}`
      : `Tool '${name}' failed (exit ${result.status})`,
  }
  if (err) body.stderr_tail = err
  else if (out) body.stdout_tail = out
  return JSON.stringify(body)
}
