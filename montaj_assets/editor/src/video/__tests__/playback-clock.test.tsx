import { render, act, screen } from '@testing-library/react'
import { createPlaybackClock, usePlaybackTime } from '../playback-clock'

test('set notifies subscribers and get returns latest', () => {
  const clock = createPlaybackClock()
  let seen = -1
  const unsub = clock.subscribe(() => { seen = clock.get() })
  clock.set(1.5)
  expect(seen).toBe(1.5)
  expect(clock.get()).toBe(1.5)
  unsub()
  clock.set(2)
  expect(seen).toBe(1.5)
})

test('set with an unchanged value does not notify', () => {
  const clock = createPlaybackClock()
  let calls = 0
  clock.subscribe(() => calls++)
  clock.set(1); clock.set(1)
  expect(calls).toBe(1)
})

test('only subscribing components re-render on tick', () => {
  const clock = createPlaybackClock()
  let siblingRenders = 0

  function TimeDisplay() {
    const t = usePlaybackTime(clock)
    return <span data-testid="t">{t}</span>
  }
  function Sibling() {
    siblingRenders++
    return null
  }
  function Root() {
    return (<><TimeDisplay /><Sibling /></>)
  }

  render(<Root />)
  const before = siblingRenders
  act(() => { clock.set(3.25) })
  expect(screen.getByTestId('t').textContent).toBe('3.25')
  expect(siblingRenders).toBe(before)
})
