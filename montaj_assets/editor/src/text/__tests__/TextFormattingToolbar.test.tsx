// @vitest-environment jsdom
/// <reference types="vitest/globals" />
import { render, screen, fireEvent } from '@testing-library/react'
import {
  isBold,
  isItalic,
  nextCase,
  isStyleProp,
  isColorProp,
  nonColorTextEntries,
  TextFormattingToolbar,
} from '../TextFormattingToolbar'
import type { OverlayElement } from '../../types'

function makeOverlay(props: Record<string, unknown> = {}): OverlayElement {
  return {
    id: 'el-1',
    type: 'overlay',
    frame: 0,
    x: 0,
    y: 0,
    w: 200,
    h: 100,
    rotation: 0,
    overlay: { template: 'assets/test.jsx', props },
  }
}

const SLIDE_ID = 'slide-1'

function renderToolbar(
  props: Record<string, unknown>,
  updateOverlayProp: ReturnType<typeof vi.fn>,
) {
  return render(
    <TextFormattingToolbar
      slideId={SLIDE_ID}
      element={makeOverlay(props)}
      updateOverlayProp={updateOverlayProp}
    />,
  )
}

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

describe('isBold', () => {
  it.each([
    ['700', true],
    ['bold', true],
    [700, true],
    ['600', true],
    ['400', false],
    [400, false],
    ['normal', false],
    [undefined, false],
    ['', false],
  ])('isBold(%s) → %s', (input, expected) => {
    expect(isBold(input)).toBe(expected)
  })
})

describe('isItalic', () => {
  it.each([
    ['italic', true],
    ['normal', false],
    ['oblique', false],
    [undefined, false],
  ])('isItalic(%s) → %s', (input, expected) => {
    expect(isItalic(input)).toBe(expected)
  })
})

describe('nextCase', () => {
  it.each([
    ['none', 'uppercase'],
    ['uppercase', 'lowercase'],
    ['lowercase', 'capitalize'],
    ['capitalize', 'none'],
    ['unknown', 'uppercase'],
  ])('nextCase(%s) → %s', (input, expected) => {
    expect(nextCase(input)).toBe(expected)
  })
})

describe('isStyleProp', () => {
  it.each([
    ['fontWeight', true],
    ['fontStyle', true],
    ['textTransform', true],
    ['textAlign', true],
    ['title', false],
    ['bg', false],
    ['color', false],
    ['', false],
  ])('isStyleProp(%s) → %s', (key, expected) => {
    expect(isStyleProp(key)).toBe(expected)
  })
})

describe('isColorProp', () => {
  it('returns true for hex values', () => {
    expect(isColorProp('anything', '#ff0000')).toBe(true)
    expect(isColorProp('anything', '#abc')).toBe(true)
    expect(isColorProp('foo', '#AABBCC')).toBe(true)
  })

  it('returns true for name-matched color keys', () => {
    expect(isColorProp('bg', 'white')).toBe(true)
    expect(isColorProp('accent', 'blue')).toBe(true)
    expect(isColorProp('foreground', 'dark')).toBe(true)
    expect(isColorProp('background', 'light')).toBe(true)
    expect(isColorProp('color', 'red')).toBe(true)
  })

  it('returns false for plain text values with non-matching keys', () => {
    expect(isColorProp('title', 'Hello world')).toBe(false)
    expect(isColorProp('subtitle', 'Some text')).toBe(false)
  })
})

describe('nonColorTextEntries', () => {
  it('filters out colors, style props, and non-strings', () => {
    const result = nonColorTextEntries({
      title: 'hi',
      bg: '#fff',
      fontWeight: '700',
      count: 5,
    })
    expect(result).toEqual([['title', 'hi']])
  })

  it('keeps multiple valid text entries', () => {
    const result = nonColorTextEntries({ title: 'Hello', subtitle: 'World' })
    expect(result).toEqual([
      ['title', 'Hello'],
      ['subtitle', 'World'],
    ])
  })

  it('returns empty array when all entries are filtered out', () => {
    const result = nonColorTextEntries({
      fontStyle: 'italic',
      bg: '#000',
      count: 3,
    })
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// TextFormattingToolbar component tests
// ---------------------------------------------------------------------------

describe('TextFormattingToolbar — bold button', () => {
  it('7. bold button writes fontWeight "700" then "400" on second click', () => {
    const updateFn = vi.fn(() => Promise.resolve())
    const { rerender } = render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={makeOverlay({ title: 'Hello', fontWeight: '400' })}
        updateOverlayProp={updateFn}
      />,
    )
    const boldBtn = screen.getByRole('button', { name: /bold/i })
    fireEvent.click(boldBtn)
    expect(updateFn).toHaveBeenCalledWith(SLIDE_ID, 'el-1', 'fontWeight', '700')

    rerender(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={makeOverlay({ title: 'Hello', fontWeight: '700' })}
        updateOverlayProp={updateFn}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /bold/i }))
    expect(updateFn).toHaveBeenCalledWith(SLIDE_ID, 'el-1', 'fontWeight', '400')
  })

  it('8. bold aria-pressed is true for bold-weight values, false otherwise', () => {
    const boldCases: Array<[unknown, boolean]> = [
      ['700', true],
      ['bold', true],
      [700, true],
      ['600', true],
      ['400', false],
      [400, false],
      ['normal', false],
      [undefined, false],
      ['', false],
    ]

    for (const [fontWeight, expectedPressed] of boldCases) {
      const props: Record<string, unknown> = { title: 'Hi' }
      if (fontWeight !== undefined) props.fontWeight = fontWeight
      const { unmount } = render(
        <TextFormattingToolbar
          slideId={SLIDE_ID}
          element={makeOverlay(props)}
          updateOverlayProp={vi.fn(() => Promise.resolve())}
        />,
      )
      if (fontWeight === undefined) {
        // fontWeight absent → bold button is hidden (prop not in contract)
        expect(screen.queryByRole('button', { name: /bold/i })).not.toBeInTheDocument()
      } else {
        const boldBtn = screen.getByRole('button', { name: /bold/i })
        expect(boldBtn.getAttribute('aria-pressed')).toBe(String(expectedPressed))
      }
      unmount()
    }
  })
})

describe('TextFormattingToolbar — italic button', () => {
  it('9. italic button writes fontStyle "italic" then "normal" on second click', () => {
    const updateFn = vi.fn(() => Promise.resolve())
    const { rerender } = render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={makeOverlay({ title: 'Hello', fontStyle: 'normal' })}
        updateOverlayProp={updateFn}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /italic/i }))
    expect(updateFn).toHaveBeenCalledWith(SLIDE_ID, 'el-1', 'fontStyle', 'italic')

    rerender(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={makeOverlay({ title: 'Hello', fontStyle: 'italic' })}
        updateOverlayProp={updateFn}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /italic/i }))
    expect(updateFn).toHaveBeenCalledWith(SLIDE_ID, 'el-1', 'fontStyle', 'normal')
  })
})

describe('TextFormattingToolbar — case button', () => {
  it('10. case button cycles none → uppercase → lowercase → capitalize → none', () => {
    const updateFn = vi.fn(() => Promise.resolve())

    const { rerender } = render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={makeOverlay({ title: 'Hello', textTransform: 'none' })}
        updateOverlayProp={updateFn}
      />,
    )
    const getCaseBtn = () => screen.getByRole('button', { name: /text case/i })
    fireEvent.click(getCaseBtn())
    expect(updateFn).toHaveBeenLastCalledWith(SLIDE_ID, 'el-1', 'textTransform', 'uppercase')

    const steps: Array<[string, string]> = [
      ['none', 'uppercase'],
      ['uppercase', 'lowercase'],
      ['lowercase', 'capitalize'],
      ['capitalize', 'none'],
    ]
    for (const [current, expected] of steps) {
      rerender(
        <TextFormattingToolbar
          slideId={SLIDE_ID}
          element={makeOverlay({ title: 'Hello', textTransform: current })}
          updateOverlayProp={updateFn}
        />,
      )
      fireEvent.click(getCaseBtn())
      expect(updateFn).toHaveBeenLastCalledWith(SLIDE_ID, 'el-1', 'textTransform', expected)
    }
  })
})

describe('TextFormattingToolbar — alignment buttons', () => {
  it('11. each alignment button writes the matching textAlign value', () => {
    const updateFn = vi.fn(() => Promise.resolve())
    renderToolbar({ title: 'Hello', textAlign: 'center' }, updateFn)

    fireEvent.click(screen.getByRole('radio', { name: /align left/i }))
    expect(updateFn).toHaveBeenLastCalledWith(SLIDE_ID, 'el-1', 'textAlign', 'left')

    fireEvent.click(screen.getByRole('radio', { name: /align center/i }))
    expect(updateFn).toHaveBeenLastCalledWith(SLIDE_ID, 'el-1', 'textAlign', 'center')

    fireEvent.click(screen.getByRole('radio', { name: /align right/i }))
    expect(updateFn).toHaveBeenLastCalledWith(SLIDE_ID, 'el-1', 'textAlign', 'right')
  })

  it('12. no alignment button is highlighted (aria-checked false) when textAlign is unset', () => {
    // textAlign must be present for the radiogroup to render, but the value
    // should not match any button. Use an empty string to make the prop present
    // but unmatched so none of the three alignment buttons show as checked.
    renderToolbar({ title: 'Hello', textAlign: '' }, vi.fn(() => Promise.resolve()))

    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(3)
    for (const radio of radios) {
      expect(radio.getAttribute('aria-checked')).toBe('false')
    }
  })
})

describe('TextFormattingToolbar — ARIA', () => {
  it('15. toolbar has role="toolbar", alignment group has role="radiogroup", B/I have aria-pressed', () => {
    renderToolbar(
      { title: 'Hello', fontWeight: '400', fontStyle: 'normal', textAlign: 'center' },
      vi.fn(() => Promise.resolve()),
    )

    expect(screen.getByRole('toolbar', { name: /text formatting/i })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /text alignment/i })).toBeInTheDocument()

    const boldBtn = screen.getByRole('button', { name: /bold/i })
    expect(boldBtn).toHaveAttribute('aria-pressed')

    const italicBtn = screen.getByRole('button', { name: /italic/i })
    expect(italicBtn).toHaveAttribute('aria-pressed')
  })
})

describe('TextFormattingToolbar — adaptive rendering by element prop schema', () => {
  function fullCompliantOverlay(): OverlayElement {
    return {
      id: 'el-1', type: 'overlay', frame: 0, x: 0, y: 0, w: 200, h: 100, rotation: 0,
      overlay: {
        template: 'assets/static-text.jsx',
        props: {
          text: 'hi', fontSize: '64', fontFamily: 'Inter', fontWeight: '400',
          fontStyle: 'normal', color: '#000', textAlign: 'center',
          textTransform: 'none', bgColor: 'transparent',
        },
      },
    };
  }

  it('renders all standard controls when every contract prop is present', () => {
    render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={fullCompliantOverlay()}
        updateOverlayProp={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(screen.getByRole('button', { name: /bold/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /italic/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /text case/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/text color/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Text background')).toBeInTheDocument();
    expect(screen.getByLabelText('Font size')).toBeInTheDocument();
    expect(screen.getByLabelText(/font family/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /align left/i })).toBeInTheDocument();
  });

  it('hides each control whose target prop is absent from the element', () => {
    const partial = makeOverlay({ text: 'hi', fontSize: '64' });
    render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={partial}
        updateOverlayProp={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(screen.queryByRole('button', { name: /bold/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /italic/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /text case/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/text color/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Text background')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Font size')).toBeInTheDocument();
    expect(screen.queryByLabelText(/font family/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /align left/i })).not.toBeInTheDocument();
  });

  it('shows a fallback hint when no standard contract props are present', () => {
    const noncompliant = makeOverlay({ headline: 'hi', headlineSize: '92', fg: '#000' });
    render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={noncompliant}
        updateOverlayProp={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(screen.queryByRole('button', { name: /bold/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Font size')).not.toBeInTheDocument();
    expect(screen.getByText(/property panel/i)).toBeInTheDocument();
  });

  it('shows the fallback hint when `text` is the only standard prop (no style controls available)', () => {
    // Realistic legacy carousel: text key carries a color hex (mis-used by an
    // older agent), no fontSize/color/weight/etc. on the element. Without the
    // hint here, the operator sees an empty toolbar with no signal about why.
    const textOnly = makeOverlay({ text: '#f8fafc', copy: 'real content', size: 58 });
    render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={textOnly}
        updateOverlayProp={vi.fn(() => Promise.resolve())}
      />,
    );
    expect(screen.queryByLabelText('Font size')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bold/i })).not.toBeInTheDocument();
    expect(screen.getByText(/property panel/i)).toBeInTheDocument();
  });

  it('keeps the delete button regardless of contract compliance (when onDelete is supplied)', () => {
    const noncompliant = makeOverlay({ headline: 'hi' });
    render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={noncompliant}
        updateOverlayProp={vi.fn(() => Promise.resolve())}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /delete text overlay/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Text background (bgColor)
// ---------------------------------------------------------------------------

describe('TextFormattingToolbar — text background', () => {
  const CLEAR = 'No text background'

  function renderBg(bgColor: unknown, update = vi.fn().mockResolvedValue(undefined)) {
    render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={makeOverlay({ text: 'hi', color: '#000000', bgColor })}
        updateOverlayProp={update}
      />,
    )
    return update
  }
  const swatch = () => screen.getByLabelText('Text background') as HTMLInputElement
  // What the swatch paints: its own fill, not the (invisible) native input.
  const fill = () => swatch().closest('label')!.querySelector('span')!.style.backgroundColor

  it('sits right after the text color: the swatch, then the clear button', () => {
    renderBg('#ff0000')
    const toolbar = screen.getByRole('toolbar', { name: /text formatting/i })
    const labels = Array.from(toolbar.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label'))
    const at = labels.indexOf('Text color')
    expect(at).toBeGreaterThan(-1)
    expect(labels.slice(at, at + 3)).toEqual(['Text color', 'Text background', CLEAR])
  })

  it('shows the saved color in the picker and the swatch', () => {
    renderBg('#336699')
    expect(swatch().value).toBe('#336699')
    expect(fill()).toBe('rgb(51, 102, 153)')
  })

  it.each(['transparent', 'rgba(0, 0, 0, 0.5)', 'red', '#fff', ''])(
    'gives the picker a plain hex when bgColor is %j, and writes nothing',
    (bg) => {
      const update = renderBg(bg)
      // Never the raw CSS string: the native picker cannot show it, and (in a
      // browser as in jsdom) turns anything it cannot show into #000000.
      expect(fill()).toMatch(/^rgb\(\d+, \d+, \d+\)$/)
      expect(swatch().value).toMatch(/^#[0-9a-f]{6}$/)
      expect(swatch().value).not.toBe('#000000')
      fireEvent.blur(swatch())
      expect(update).not.toHaveBeenCalled()
    },
  )

  it('a pick previews in the swatch and writes bgColor once, on commit', () => {
    const update = renderBg('transparent')
    fireEvent.change(swatch(), { target: { value: '#00ff00' } })
    fireEvent.change(swatch(), { target: { value: '#ff0000' } })
    expect(fill()).toBe('rgb(255, 0, 0)')
    expect(update).not.toHaveBeenCalled()

    fireEvent.blur(swatch(), { target: { value: '#ff0000' } })
    expect(update.mock.calls).toEqual([[SLIDE_ID, 'el-1', 'bgColor', '#ff0000']])
  })

  it.each(['#ffffff', '#000000'])('a box with no background can be given %s in one pick', (hex) => {
    // The native picker fires nothing for the color it already shows, so what
    // it shows for a transparent box must not be a color people want.
    const update = renderBg('transparent')
    fireEvent.change(swatch(), { target: { value: hex } })
    fireEvent.blur(swatch(), { target: { value: hex } })
    expect(update.mock.calls).toEqual([[SLIDE_ID, 'el-1', 'bgColor', hex]])
  })

  it('a blur with no pick, or a pick that ends on the starting color, writes nothing', () => {
    const update = renderBg('#336699')
    fireEvent.blur(swatch(), { target: { value: '#336699' } })
    fireEvent.change(swatch(), { target: { value: '#112233' } })
    fireEvent.change(swatch(), { target: { value: '#336699' } })
    fireEvent.blur(swatch(), { target: { value: '#336699' } })
    expect(update).not.toHaveBeenCalled()
    expect(fill()).toBe('rgb(51, 102, 153)')
  })

  it('follows the saved color when the element or its value changes underneath', () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const at = (id: string, bgColor: string) => ({ ...makeOverlay({ text: 'hi', bgColor }), id })
    const { rerender } = render(
      <TextFormattingToolbar slideId={SLIDE_ID} element={at('el-1', '#111111')} updateOverlayProp={update} />,
    )
    fireEvent.change(swatch(), { target: { value: '#999999' } })
    expect(swatch().value).toBe('#999999')

    rerender(<TextFormattingToolbar slideId={SLIDE_ID} element={at('el-2', '#222222')} updateOverlayProp={update} />)
    expect(swatch().value).toBe('#222222')
    rerender(<TextFormattingToolbar slideId={SLIDE_ID} element={at('el-2', '#333333')} updateOverlayProp={update} />)
    expect(swatch().value).toBe('#333333')
    expect(update).not.toHaveBeenCalled()
  })

  it('the clear button writes "transparent" once', () => {
    const update = renderBg('#ff0000')
    fireEvent.click(screen.getByRole('button', { name: CLEAR }))
    expect(update.mock.calls).toEqual([[SLIDE_ID, 'el-1', 'bgColor', 'transparent']])
  })

  it.each(['#ff0000', 'rgba(0, 0, 0, 0.5)', 'red'])('shows the clear button while bgColor is %j', (bg) => {
    renderBg(bg)
    expect(screen.getByRole('button', { name: CLEAR })).toBeInTheDocument()
  })

  it.each(['transparent', 'Transparent', ''])('hides the clear button when bgColor is already %j', (bg) => {
    renderBg(bg)
    expect(screen.getByLabelText('Text background')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument()
  })

  it.each([{ fontSize: '64' }, { bgColor: null }])('an overlay without bgColor (%j) shows neither control', (extra) => {
    render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={makeOverlay({ text: 'hi', color: '#000000', ...extra })}
        updateOverlayProp={vi.fn()}
      />,
    )
    expect(screen.getByLabelText(/text color/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Text background')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: CLEAR })).not.toBeInTheDocument()
  })

  it('an overlay whose only contract prop is bgColor still gets the control, not the fallback hint', () => {
    render(
      <TextFormattingToolbar
        slideId={SLIDE_ID}
        element={makeOverlay({ text: 'hi', bgColor: '#ff0000' })}
        updateOverlayProp={vi.fn()}
      />,
    )
    expect(screen.getByLabelText('Text background')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: CLEAR })).toBeInTheDocument()
    expect(screen.queryByText(/property panel/i)).not.toBeInTheDocument()
  })
})
