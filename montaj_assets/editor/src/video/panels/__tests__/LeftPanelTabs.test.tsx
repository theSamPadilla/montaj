import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import LeftPanelTabs, { type LeftPanelTab } from '../LeftPanelTabs'

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

function makeTabs(): LeftPanelTab[] {
  return [
    { id: 'media', icon: <span>M</span>, label: 'Media', content: <div data-testid="media-content">Media panel</div> },
    { id: 'captions', icon: <span>C</span>, label: 'Captions', content: <div data-testid="captions-content">Captions panel</div> },
    { id: 'versions', icon: <span>V</span>, label: 'Versions', content: <div data-testid="versions-content">Versions panel</div> },
  ]
}

describe('LeftPanelTabs', () => {
  it('renders one tab per entry, with its label text', () => {
    render(<LeftPanelTabs tabs={makeTabs()} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(screen.getByText('Media')).toBeTruthy()
    expect(screen.getByText('Captions')).toBeTruthy()
    expect(screen.getByText('Versions')).toBeTruthy()
  })

  it('shows the default tab content and does not mount a non-default tab until first activation', () => {
    render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="captions" />)
    expect(screen.getByTestId('captions-content')).toBeTruthy()
    expect(screen.queryByTestId('media-content')).toBeNull()
    expect(screen.queryByTestId('versions-content')).toBeNull()
  })

  it('clicking a tab shows its content and hides the previous one', () => {
    render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="captions" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Media' }))

    const mediaPanel = screen.getByTestId('media-content').closest('[role="tabpanel"]') as HTMLElement
    const captionsPanel = screen.getByTestId('captions-content').closest('[role="tabpanel"]') as HTMLElement
    expect(mediaPanel.hidden).toBe(false)
    expect(captionsPanel.hidden).toBe(true)
  })

  it('keeps a tab mounted after switching away from it (state survives a tab switch)', () => {
    render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="captions" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Media' }))
    // Switch back to captions.
    fireEvent.click(screen.getByRole('tab', { name: 'Captions' }))

    // Media was mounted when activated; it should still be in the DOM, just hidden.
    const mediaContent = screen.getByTestId('media-content')
    expect(mediaContent).toBeTruthy()
    const mediaPanel = mediaContent.closest('[role="tabpanel"]') as HTMLElement
    expect(mediaPanel.hidden).toBe(true)
  })

  it('persists the active tab to localStorage under the default key, and restores it on a fresh render', () => {
    const { unmount } = render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="captions" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Media' }))
    expect(window.localStorage.getItem('montaj.editor.leftPanelTab')).toBe(JSON.stringify('media'))
    unmount()

    render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="captions" />)
    expect(screen.getByTestId('media-content')).toBeTruthy()
    expect(screen.queryByTestId('captions-content')).toBeNull()
  })

  it('falls back to defaultTabId when the persisted value is not a string', () => {
    // The other half of `revive`'s guard: a stored value of the wrong TYPE
    // (an older key format, a hand-edited entry) must degrade to the default
    // rather than being handed through as an active tab id.
    window.localStorage.setItem('montaj.editor.leftPanelTab', JSON.stringify(3))
    render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="versions" />)
    expect(screen.getByTestId('versions-content')).toBeTruthy()
  })

  it('hides an inactive panel with inline display:none, not just the hidden attribute', () => {
    // `hidden` alone is a UA-stylesheet `display: none`, which loses to the
    // panel wrapper's own `flex` utility class. The inline style is the line
    // actually doing the hiding, so it gets its own assertion.
    render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="captions" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Media' }))

    const captionsPanel = screen.getByTestId('captions-content').closest('[role="tabpanel"]') as HTMLElement
    expect(captionsPanel.hidden).toBe(true)
    expect(captionsPanel.style.display).toBe('none')
  })

  it('falls back to defaultTabId when the persisted id is stale/unknown', () => {
    window.localStorage.setItem('montaj.editor.leftPanelTab', JSON.stringify('some-removed-tab'))
    render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="versions" />)
    expect(screen.getByTestId('versions-content')).toBeTruthy()
    expect(screen.queryByTestId('media-content')).toBeNull()
    expect(screen.queryByTestId('captions-content')).toBeNull()
  })

  it('falls back to tabs[0] when defaultTabId is absent', () => {
    render(<LeftPanelTabs tabs={makeTabs()} />)
    expect(screen.getByTestId('media-content')).toBeTruthy()
  })

  it('has aria-selected true on exactly one tab, wired via aria-labelledby/aria-controls', () => {
    render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="captions" />)
    const tabs = screen.getAllByRole('tab')
    const selected = tabs.filter(t => t.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0].textContent).toContain('Captions')

    const panel = screen.getByRole('tabpanel')
    expect(panel.getAttribute('aria-labelledby')).toBe(selected[0].id)
    expect(selected[0].getAttribute('aria-controls')).toBe(panel.id)
  })

  it('supports an empty tabs array without crashing', () => {
    render(<LeftPanelTabs tabs={[]} />)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryAllByRole('tabpanel')).toHaveLength(0)
  })

  describe('keyboard navigation on the rail', () => {
    it('ArrowDown moves to the next tab and wraps at the end', () => {
      render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="media" />)
      const media = screen.getByRole('tab', { name: 'Media' })
      media.focus()

      fireEvent.keyDown(media, { key: 'ArrowDown' })
      expect(screen.getByTestId('captions-content')).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Captions' }))

      fireEvent.keyDown(screen.getByRole('tab', { name: 'Captions' }), { key: 'ArrowDown' })
      expect(screen.getByTestId('versions-content')).toBeTruthy()

      // Wraps from the last tab back to the first.
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Versions' }), { key: 'ArrowDown' })
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Media' }))
    })

    it('Home and End jump to the first and last tab', () => {
      render(<LeftPanelTabs tabs={makeTabs()} defaultTabId="captions" />)
      const captions = screen.getByRole('tab', { name: 'Captions' })

      fireEvent.keyDown(captions, { key: 'End' })
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Versions' }))

      fireEvent.keyDown(screen.getByRole('tab', { name: 'Versions' }), { key: 'Home' })
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Media' }))
    })
  })
})
