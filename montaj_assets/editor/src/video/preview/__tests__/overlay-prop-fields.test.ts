/// <reference types="vitest/globals" />
import { inferOverlayPropFields } from '../overlay-prop-fields'

test('infers kinds from values', () => {
  const fields = inferOverlayPropFields({
    homeName: 'Colombia',
    homeScore: 2,
    accent: '#FCD116',
    muted: false,
    players: [{ name: 'x' }],       // non-primitive: skipped
    onClick: () => {},              // non-primitive: skipped
    homeSrc: '/path/to/crest.png',  // image path → image kind
  })
  expect(fields).toEqual([
    { name: 'homeName', kind: 'text', value: 'Colombia' },
    { name: 'homeScore', kind: 'number', value: 2 },
    { name: 'accent', kind: 'color', value: '#FCD116' },
    { name: 'muted', kind: 'boolean', value: false },
    { name: 'homeSrc', kind: 'image', value: '/path/to/crest.png' },
  ])
})

test('detects image paths (extensions, query/hash, data URLs) vs plain text', () => {
  const f = inferOverlayPropFields({
    a: '/assets/logo.PNG',
    b: 'https://cdn.x/y.jpg?v=2',
    c: 'photo.webp#frag',
    d: 'inline.svg',
    e: 'data:image/png;base64,AAAA',
    f: '/notes/readme.txt',   // not an image
    g: 'just some words',     // not an image
  })
  expect(f.map(x => x.kind)).toEqual(['image', 'image', 'image', 'image', 'image', 'text', 'text'])
})

test('preserves insertion order and handles empty/absent props', () => {
  expect(inferOverlayPropFields({})).toEqual([])
  expect(inferOverlayPropFields(undefined)).toEqual([])
})

test('color detection is strict hex only', () => {
  const f = inferOverlayPropFields({ a: '#ff0', b: '#FFAA00CC', c: '#xyz', d: 'red' })
  expect(f.map(x => x.kind)).toEqual(['color', 'color', 'text', 'text'])
})
