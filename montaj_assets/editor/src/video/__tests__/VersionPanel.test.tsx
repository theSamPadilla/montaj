import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { VersionEntry } from '../../types'
import VersionPanel, { listVersions, humanizeLabel } from '../VersionPanel'

afterEach(cleanup)

// Mirrors VersionPanel's own `formatTime` exactly, so the timestamp assertion
// doesn't hardcode a locale-specific string — it checks against whatever the
// panel actually renders for this environment's locale.
function expectedTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

describe('VersionPanel', () => {
  it('renders every version as its own row, including two versions sharing a run number', () => {
    const versions: VersionEntry[] = [
      { hash: 'abc', message: 'version: run 2 — export', timestamp: '2026-01-01T12:00:00Z' },
      { hash: 'def', message: 'version: run 2 — My Checkpoint', timestamp: '2026-01-01T13:00:00Z' },
      { hash: 'ghi', message: 'version: run 1 — draft', timestamp: '2025-12-31T08:15:00Z' },
    ]
    const { container } = render(
      <VersionPanel versions={versions} restoring={null} onRestore={vi.fn()} />,
    )

    expect(container.textContent).toContain('Exported')
    expect(container.textContent).toContain('My Checkpoint')
    expect(container.textContent).toContain('Draft')
    expect(container.textContent).toContain(expectedTimestamp('2026-01-01T12:00:00Z'))
    expect(container.textContent).toContain(expectedTimestamp('2026-01-01T13:00:00Z'))
    expect(container.textContent).toContain(expectedTimestamp('2025-12-31T08:15:00Z'))
  })

  it('never renders the string "Run "', () => {
    const versions: VersionEntry[] = [
      { hash: 'abc', message: 'version: run 2 — export', timestamp: '2026-01-01T12:00:00Z' },
      { hash: 'def', message: 'version: run 1 — draft', timestamp: '2025-12-31T08:15:00Z' },
    ]
    const { container } = render(
      <VersionPanel versions={versions} restoring={null} onRestore={vi.fn()} />,
    )

    expect(container.textContent).not.toContain('Run ')
  })

  it('filters out run-0 init-baseline entries', () => {
    const versions: VersionEntry[] = [
      { hash: 'init', message: 'initial commit', timestamp: '2025-12-30T00:00:00Z' },
      { hash: 'abc', message: 'version: run 1 — draft', timestamp: '2026-01-01T00:00:00Z' },
    ]
    const { container } = render(
      <VersionPanel versions={versions} restoring={null} onRestore={vi.fn()} />,
    )

    expect(container.textContent).toContain('Draft')
    expect(container.textContent).not.toContain('initial commit')
    // Header count reflects only the non-init entry, shown as an explicit
    // "N versions" label on the right (no collapse control — Versions has its
    // own tab now).
    expect(screen.getByText('1 version')).toBeTruthy()
  })

  it('orders rows newest-first by timestamp regardless of input order', () => {
    const versions: VersionEntry[] = [
      { hash: 'oldest', message: 'version: run 1 — draft', timestamp: '2025-12-01T00:00:00Z' },
      { hash: 'newest', message: 'version: run 3 — export', timestamp: '2026-01-15T00:00:00Z' },
      { hash: 'middle', message: 'version: run 2 — final', timestamp: '2026-01-01T00:00:00Z' },
    ]
    const { container } = render(
      <VersionPanel versions={versions} restoring={null} onRestore={vi.fn()} />,
    )

    const names = ['Exported', 'Final', 'Draft']
    const positions = names.map(n => container.textContent!.indexOf(n))
    expect(positions[0]).toBeLessThan(positions[1])
    expect(positions[1]).toBeLessThan(positions[2])
  })

  describe('humanizeLabel', () => {
    it('maps known labels to their humanized form, case-insensitively', () => {
      expect(humanizeLabel('draft')).toBe('Draft')
      expect(humanizeLabel('Draft')).toBe('Draft')
      expect(humanizeLabel('export')).toBe('Exported')
      expect(humanizeLabel('final')).toBe('Final')
      expect(humanizeLabel('pending')).toBe('Pending')
      expect(humanizeLabel('autosave before restore')).toBe('Auto-save before restore')
      expect(humanizeLabel('AUTOSAVE BEFORE RESTORE')).toBe('Auto-save before restore')
    })

    it('returns "Untitled save" for an empty or whitespace-only label', () => {
      expect(humanizeLabel('')).toBe('Untitled save')
      expect(humanizeLabel('   ')).toBe('Untitled save')
    })

    it('returns an operator-typed name verbatim', () => {
      expect(humanizeLabel('My Checkpoint')).toBe('My Checkpoint')
    })
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

  it('Restore and Compare call back with the right hash per row in a multi-row list', () => {
    const versions: VersionEntry[] = [
      { hash: 'abc', message: 'version: run 2 — export', timestamp: '2026-01-01T12:00:00Z' },
      { hash: 'def', message: 'version: run 1 — draft', timestamp: '2025-12-31T08:15:00Z' },
    ]
    const onRestore = vi.fn()
    const onCompareVersion = vi.fn()
    render(
      <VersionPanel
        versions={versions}
        restoring={null}
        onRestore={onRestore}
        onCompareVersion={onCompareVersion}
      />,
    )

    const restoreButtons = screen.getAllByText('Restore →')
    const compareButtons = screen.getAllByText('Compare')
    expect(restoreButtons).toHaveLength(2)
    expect(compareButtons).toHaveLength(2)

    // Newest-first: row 0 is 'abc' (2026-01-01), row 1 is 'def' (2025-12-31).
    fireEvent.click(restoreButtons[0])
    expect(onRestore).toHaveBeenCalledWith('abc')
    fireEvent.click(restoreButtons[1])
    expect(onRestore).toHaveBeenCalledWith('def')

    fireEvent.click(compareButtons[0])
    expect(onCompareVersion).toHaveBeenCalledWith('abc')
    fireEvent.click(compareButtons[1])
    expect(onCompareVersion).toHaveBeenCalledWith('def')
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

describe('listVersions', () => {
  it('filters out run-0 entries, keeps every remaining version flat (no per-run collapsing)', () => {
    const versions: VersionEntry[] = [
      { hash: 'init', message: 'initial commit', timestamp: '2025-12-30T00:00:00Z' },
      { hash: 'a', message: 'version: run 1 — draft', timestamp: '2026-01-01T00:00:00Z' },
      { hash: 'b', message: 'version: run 1 — final', timestamp: '2026-01-02T00:00:00Z' },
    ]
    const result = listVersions(versions)
    expect(result.map(v => v.hash)).toEqual(['b', 'a'])
  })

  it('sorts newest-first by timestamp', () => {
    const versions: VersionEntry[] = [
      { hash: 'old', message: 'version: run 1 — draft', timestamp: '2025-01-01T00:00:00Z' },
      { hash: 'new', message: 'version: run 2 — export', timestamp: '2026-01-01T00:00:00Z' },
      { hash: 'mid', message: 'version: run 3 — final', timestamp: '2025-06-01T00:00:00Z' },
    ]
    const result = listVersions(versions)
    expect(result.map(v => v.hash)).toEqual(['new', 'mid', 'old'])
  })

  it('is stable for ties: same-timestamp entries keep their input order', () => {
    const versions: VersionEntry[] = [
      { hash: 'first', message: 'version: run 1 — draft', timestamp: '2026-01-01T00:00:00Z' },
      { hash: 'second', message: 'version: run 2 — export', timestamp: '2026-01-01T00:00:00Z' },
      { hash: 'third', message: 'version: run 3 — final', timestamp: '2026-01-01T00:00:00Z' },
    ]
    const result = listVersions(versions)
    expect(result.map(v => v.hash)).toEqual(['first', 'second', 'third'])
  })

  it('treats an unparseable timestamp as sorting last, without throwing', () => {
    const versions: VersionEntry[] = [
      { hash: 'bad', message: 'version: run 1 — draft', timestamp: 'not-a-date' },
      { hash: 'good', message: 'version: run 2 — export', timestamp: '2026-01-01T00:00:00Z' },
    ]
    expect(() => listVersions(versions)).not.toThrow()
    const result = listVersions(versions)
    expect(result.map(v => v.hash)).toEqual(['good', 'bad'])
  })

  it('does not mutate the input array', () => {
    const versions: VersionEntry[] = [
      { hash: 'old', message: 'version: run 1 — draft', timestamp: '2025-01-01T00:00:00Z' },
      { hash: 'new', message: 'version: run 2 — export', timestamp: '2026-01-01T00:00:00Z' },
    ]
    const original = [...versions]
    listVersions(versions)
    expect(versions).toEqual(original)
  })

})
