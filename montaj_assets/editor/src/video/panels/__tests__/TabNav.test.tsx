import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import TabNav, { type TabNavTab } from '../TabNav'

afterEach(cleanup)

type Tab = 'content' | 'transform' | 'style'

function makeTabs(): TabNavTab<Tab>[] {
  return [
    { value: 'content', label: 'Content' },
    { value: 'transform', label: 'Transform' },
    { value: 'style', label: 'Style' },
  ]
}

describe('TabNav', () => {
  it('renders one button per tab, with its label text', () => {
    render(<TabNav tabs={makeTabs()} value="content" onChange={() => {}} ariaLabel="Test panel view" />)
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.getByText('Content')).toBeTruthy()
    expect(screen.getByText('Transform')).toBeTruthy()
    expect(screen.getByText('Style')).toBeTruthy()
  })

  it('marks the active tab aria-pressed=true and the others aria-pressed=false', () => {
    render(<TabNav tabs={makeTabs()} value="transform" onChange={() => {}} ariaLabel="Test panel view" />)
    expect(screen.getByText('Content').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('Transform').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('Style').getAttribute('aria-pressed')).toBe('false')
  })

  it('calls onChange with the clicked tab value', () => {
    const onChange = vi.fn()
    render(<TabNav tabs={makeTabs()} value="content" onChange={onChange} ariaLabel="Test panel view" />)
    fireEvent.click(screen.getByText('Style'))
    expect(onChange).toHaveBeenCalledWith('style')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('exposes the given ariaLabel on the group', () => {
    render(<TabNav tabs={makeTabs()} value="content" onChange={() => {}} ariaLabel="Overlay panel view" />)
    expect(screen.getByRole('group', { name: 'Overlay panel view' })).toBeTruthy()
  })

  it('renders no element with role="tab" or role="tablist"', () => {
    // Pins the deliberate aria-pressed-not-role="tab" decision: a second
    // tablist anywhere in the tree collides with the host's LEFT rail
    // (LeftPanelTabs), which is a real role="tablist".
    render(<TabNav tabs={makeTabs()} value="content" onChange={() => {}} ariaLabel="Test panel view" />)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    expect(screen.queryAllByRole('tablist')).toHaveLength(0)
  })

  it('merges an extra className onto the wrapper alongside the base classes', () => {
    render(
      <TabNav
        tabs={makeTabs()}
        value="content"
        onChange={() => {}}
        ariaLabel="Test panel view"
        className="shrink-0 border-b border-[var(--editor-border)]"
      />,
    )
    const group = screen.getByRole('group', { name: 'Test panel view' })
    expect(group.className).toContain('flex')
    expect(group.className).toContain('items-center')
    expect(group.className).toContain('shrink-0')
    expect(group.className).toContain('border-b')
  })
})
