import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { VisualItem } from '@/lib/types/schema'
import VideoPreviewModal from '../VideoPreviewModal'

function source(overrides: Partial<VisualItem> = {}): VisualItem {
  return {
    id: 'src-1',
    type: 'video',
    src: '/videos/clip-one.mp4',
    start: 0,
    end: 0,
    sourceDuration: 10,
    proxySrc: '/videos/clip-one_proxy.mp4',
    ...overrides,
  }
}

const fileUrl = (p: string) => `/files?path=${p}`

describe('VideoPreviewModal', () => {
  it('shows the filename and sources the video from the original file', () => {
    render(
      <VideoPreviewModal source={source()} fileUrl={fileUrl} onClose={vi.fn()} onRemove={vi.fn()} />,
    )
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'clip-one.mp4')
    expect(screen.getByText('clip-one.mp4')).toBeInTheDocument()
    const video = document.querySelector('video') as HTMLVideoElement
    expect(video).toBeTruthy()
    expect(video.getAttribute('src')).toBe('/files?path=/videos/clip-one.mp4')
  })

  it('falls back to the proxy source when the original src is absent', () => {
    render(
      <VideoPreviewModal
        source={source({ src: undefined })}
        fileUrl={fileUrl}
        onClose={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    const video = document.querySelector('video') as HTMLVideoElement
    expect(video.getAttribute('src')).toBe('/files?path=/videos/clip-one_proxy.mp4')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<VideoPreviewModal source={source()} fileUrl={fileUrl} onClose={onClose} onRemove={vi.fn()} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on clicking the X button', () => {
    const onClose = vi.fn()
    render(<VideoPreviewModal source={source()} fileUrl={fileUrl} onClose={onClose} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on clicking the backdrop but not on clicking the video', () => {
    const onClose = vi.fn()
    render(<VideoPreviewModal source={source()} fileUrl={fileUrl} onClose={onClose} onRemove={vi.fn()} />)

    const video = document.querySelector('video') as HTMLVideoElement
    fireEvent.click(video)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Delete calls onRemove with the source id and closes the modal', () => {
    const onClose = vi.fn()
    const onRemove = vi.fn()
    render(<VideoPreviewModal source={source()} fileUrl={fileUrl} onClose={onClose} onRemove={onRemove} />)

    fireEvent.click(screen.getByText('Delete'))

    expect(onRemove).toHaveBeenCalledWith('src-1')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
