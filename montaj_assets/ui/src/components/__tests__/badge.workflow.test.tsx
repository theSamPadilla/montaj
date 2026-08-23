/// <reference types="vitest/globals" />
/**
 * WorkflowBadge — the project list's "which recipe built this" chip.
 *
 * The one behaviour worth pinning is that the name is shown verbatim. Users
 * add their own workflows as JSON files, so any prettifying map would cover the
 * built-ins and quietly miss everything custom.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusBadge, WorkflowBadge } from '../ui/badge'

describe('WorkflowBadge', () => {
  it('shows the workflow name exactly as the picker and the CLI spell it', () => {
    render(<WorkflowBadge workflow="clean_cut" />)
    expect(screen.getByText('clean_cut')).toBeInTheDocument()
  })

  it('shows a custom workflow name it has never seen before', () => {
    render(<WorkflowBadge workflow="my_studio_recipe" />)
    expect(screen.getByText('my_studio_recipe')).toBeInTheDocument()
  })

  it('renders nothing for a legacy project that predates the field', () => {
    const { container } = render(<WorkflowBadge workflow={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing rather than an empty chip for a blank workflow', () => {
    const { container } = render(<WorkflowBadge workflow="" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('stays neutral so the status badge beside it keeps the colour', () => {
    const { container } = render(
      <>
        <StatusBadge status="draft" />
        <WorkflowBadge workflow="broll" />
      </>,
    )
    const [status, workflow] = Array.from(container.querySelectorAll('span'))
    expect(status.className).toContain('blue')
    expect(workflow.className).toContain('gray')
  })
})
