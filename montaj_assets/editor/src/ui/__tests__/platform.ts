/** Test helper: pretend `navigator.platform` is `value`; returns a restore fn. */
export function stubPlatform(value: string): () => void {
  Object.defineProperty(navigator, 'platform', { value, configurable: true })
  return () => {
    delete (navigator as unknown as { platform?: string }).platform
  }
}
