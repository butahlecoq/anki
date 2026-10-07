import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

// Node integration suites need native SQLite and the same browser data primitives.
if (typeof window === 'undefined') {
  const { JSDOM } = await import('jsdom')
  const browser = new JSDOM('', { url: 'http://localhost/' }).window
  for (const key of ['window', 'document', 'FileReader', 'DOMParser', 'HTMLElement'] as const) {
    Object.defineProperty(globalThis, key, { value: browser[key], configurable: true, writable: true })
  }
}
