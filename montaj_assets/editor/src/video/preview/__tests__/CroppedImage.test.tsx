/// <reference types="vitest/globals" />
import { render, fireEvent } from '@testing-library/react'
import CroppedImage from '../CroppedImage'

function load(img: HTMLImageElement, w: number, h: number) {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: w })
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: h })
  fireEvent.load(img)
}

describe('CroppedImage (PV55)', () => {
  it('without a crop it is the exact <img> it replaced', () => {
    const { container } = render(<CroppedImage src="a.jpg" crop={undefined} fit="cover" boxWidth={1080} boxHeight={1920} />)
    const img = container.querySelector('img')!
    expect(img.className).toBe('absolute inset-0 w-full h-full pointer-events-none')
    expect(img.style.objectFit).toBe('cover')
    expect(img.parentElement).toBe(container)
  })
  it('with a crop: hidden until loaded, then placed inside an overflow-hidden clip box', () => {
    const { container } = render(<CroppedImage src="a.jpg" crop={{ x: 0.5, y: 0, w: 0.25, h: 1 }} fit="cover" boxWidth={1080} boxHeight={1920} />)
    const img = container.querySelector('img')!
    expect(img.style.visibility).toBe('hidden')
    load(img, 2000, 1000)
    const after = container.querySelector('img')!
    expect(after.style.visibility).toBe('')
    expect(after.style.width).toBe('400%')
    expect((after.parentElement as HTMLElement).style.overflow).toBe('hidden')
    expect((after.parentElement as HTMLElement).style.height).toBe('112.5%')
  })
})
