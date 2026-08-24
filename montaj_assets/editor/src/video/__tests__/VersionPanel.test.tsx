import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { VersionEntry } from '../../types'
import VersionPanel from '../VersionPanel'

afterEach(cleanup)

// Mirrors VersionPanel's own `formatTime` exactly, so the timestamp assertion
// doesn't hardcode a locale-specific string — it checks against whatever the
// panel actually renders for this environment's locale.
function expectedTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

describe('VersionPanel', () => {
  it("renders each entry's run, label, and timestamp", () => {
    const versions: VersionEntry[] = [
      { hash: 'abc', message: 'version: run 2 — export', timestamp: '2026-01-01T12:00:00Z' },
      { hash: 'def', message: 'version: run 1 — draft', timestamp: '2025-12-31T08:15:00Z' },
    ]
    const { container } = render(
      <VersionPanel versions={versions} restoring={null} onRestore={vi.fn()} />,
    )

    expect(container.textContent).toContain('Run 2')
    expect(container.textContent).toContain('export')
    expect(container.textContent).toContain(expectedTimestamp('2026-01-01T12:00:00Z'))

    expect(container.textContent).toContain('Run 1')
    expect(container.textContent).toContain('draft')
    expect(container.textContent).toContain(expectedTimestamp('2025-12-31T08:15:00Z'))
  })

  it('"Restore →" click calls onRestore with the entry\'s hash', () => {
    const versions: VersionEntry[] = [
      { hash: 'abc123', message: 'version: run 1 — draft', timestamp: '2026-01-01T00:00:00Z' },
    ]
    const onRestore = vi.fn()
    render(<VersionPanel versions={versions} restoring={null} onRestore={onRestore} />)

    fireEvent.click(screen.getByText('Restore →'))
    expect(onRestore).toHaveBeenCalledWith('abc123')
  })

  it('"Save version" clicked with empty input calls onSaveVersion(undefined)', () => {
    const onSaveVersion = vi.fn()
    render(<VersionPanel versions={[]} restoring={null} onRestore={vi.fn()} onSaveVersion={onSaveVersion} />)

    fireEvent.click(screen.getByText('Save version'))
    expect(onSaveVersion).toHaveBeenCalledWith(undefined)
  })

  it('"Save version" clicked with a typed name calls onSaveVersion with the trimmed name', () => {
    const onSaveVersion = vi.fn()
    render(<VersionPanel versions={[]} restoring={null} onRestore={vi.fn()} onSaveVersion={onSaveVersion} />)

    const input = screen.getByPlaceholderText('Name (optional)')
    fireEvent.change(input, { target: { value: '  My Checkpoint  ' } })
    fireEvent.click(screen.getByText('Save version'))

    expect(onSaveVersion).toHaveBeenCalledWith('My Checkpoint')
  })

  it('clears the name input after a save click', () => {
    const onSaveVersion = vi.fn()
    render(<VersionPanel versions={[]} restoring={null} onRestore={vi.fn()} onSaveVersion={onSaveVersion} />)

    const input = screen.getByPlaceholderText('Name (optional)') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'temp name' } })
    expect(input.value).toBe('temp name')

    fireEvent.click(screen.getByText('Save version'))
    expect(input.value).toBe('')
  })

  it('disables the save input and button when saving is true', () => {
    render(<VersionPanel versions={[]} restoring={null} onRestore={vi.fn()} onSaveVersion={vi.fn()} saving />)

    expect(screen.getByPlaceholderText('Name (optional)')).toBeDisabled()
    expect(screen.getByText('Saving…')).toBeDisabled()
  })

  // Spec note: the Save row is NEVER unmounted — per VersionPanel's own
  // comment it "always visible... Disabled rather than hidden when the host
  // has no onSaveVersion", matching the Restore buttons' degrade-gracefully
  // pattern. This test pins that actual (documented) behavior: the input and
  // button stay in the DOM but disabled, rather than disappearing.
  it('disables (rather than removing) the save input and button when onSaveVersion is undefined', () => {
    render(<VersionPanel versions={[]} restoring={null} onRestore={vi.fn()} />)

    expect(screen.getByPlaceholderText('Name (optional)')).toBeDisabled()
    expect(screen.getByText('Save version')).toBeDisabled()
  })

  it('"Compare" button click calls onCompareVersion with the hash', () => {
    const versions: VersionEntry[] = [
      { hash: 'abc123', message: 'version: run 1 — draft', timestamp: '2026-01-01T00:00:00Z' },
    ]
    const onCompareVersion = vi.fn()
    render(
      <VersionPanel versions={versions} restoring={null} onRestore={vi.fn()} onCompareVersion={onCompareVersion} />,
    )

    fireEvent.click(screen.getByText('Compare'))
    expect(onCompareVersion).toHaveBeenCalledWith('abc123')
  })

  it('does not render the "Compare" button when onCompareVersion is undefined', () => {
    const versions: VersionEntry[] = [
      { hash: 'abc123', message: 'version: run 1 — draft', timestamp: '2026-01-01T00:00:00Z' },
    ]
    render(<VersionPanel versions={versions} restoring={null} onRestore={vi.fn()} />)

    expect(screen.queryByText('Compare')).toBeNull()
  })

  it("disables only the matching entry's Restore button when restoring", () => {
    const versions: VersionEntry[] = [
      { hash: 'abc', message: 'version: run 2 — export', timestamp: '2026-01-01T12:00:00Z' },
      { hash: 'def', message: 'version: run 1 — draft', timestamp: '2025-12-31T08:15:00Z' },
    ]
    render(<VersionPanel versions={versions} restoring="abc" onRestore={vi.fn()} />)

    expect(screen.getByText('Restoring…')).toBeDisabled()
    expect(screen.getByText('Restore →')).not.toBeDisabled()
  })
})
