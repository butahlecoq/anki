import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { App } from './App'
import {
  APPEARANCE_FALLBACK_COLORS,
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  chooseAppearance,
  readAppearance,
  resolveAppearance,
  storeAppearance,
  watchAppearance,
  type Appearance,
} from './appearance'

const originalMatchMedia = window.matchMedia

function setSystemPrefersDark(dark: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: dark,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  setSystemPrefersDark(true)
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  window.matchMedia = originalMatchMedia
})

describe('appearance preference', () => {
  test('defaults to following the operating system', () => {
    expect(readAppearance()).toBe('system')
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
  })

  test('an explicit choice overrides the operating system', () => {
    expect(resolveAppearance('light', true)).toBe('light')
    expect(resolveAppearance('dark', false)).toBe('dark')
  })

  test('applies the light theme to chrome only, leaving the default dark document untouched', () => {
    applyAppearance('dark')
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    applyAppearance('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    applyAppearance('dark')
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })

  test('remembers a choice across a reload', () => {
    storeAppearance('light')
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('light')
    expect(readAppearance()).toBe('light')
  })

  test('ignores an unrecognised stored value instead of failing to render', () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'chartreuse')
    expect(readAppearance()).toBe('system')
  })

  test('survives storage that throws on access', () => {
    const hostile = {
      getItem() { throw new Error('blocked') },
      setItem() { throw new Error('blocked') },
    } as unknown as Storage
    expect(readAppearance(hostile)).toBe('system')
    expect(() => storeAppearance('light', hostile)).not.toThrow()
  })

  test('watcher reflects a later choice without remounting', () => {
    const stop = watchAppearance()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    chooseAppearance('light')
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    chooseAppearance('dark')
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    stop()
  })

  test('a preference changed in another window is adopted', () => {
    const stop = watchAppearance()
    expect(document.documentElement).not.toHaveAttribute('data-theme')
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'light')
    fireEvent(window, new StorageEvent('storage', { key: APPEARANCE_STORAGE_KEY }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    stop()
  })

  test('a stopped watcher no longer reacts', () => {
    const stop = watchAppearance()
    stop()
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'light')
    fireEvent(window, new StorageEvent('storage', { key: APPEARANCE_STORAGE_KEY }))
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })
})

describe('browser chrome colour', () => {
  // index.html is not part of the jsdom document, so the suite supplies the
  // meta tag the shipped page declares. tests/e2e/appearance.spec.ts reads the
  // real one in a browser.
  const themeColorMeta = () => document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')

  beforeEach(() => {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = '#0b0d10'
    document.head.appendChild(meta)
  })

  afterEach(() => {
    themeColorMeta()?.remove()
    document.documentElement.style.removeProperty('--surface-page')
  })

  test('tracks the applied theme so an installed app status bar stays readable', () => {
    applyAppearance('dark')
    expect(themeColorMeta()?.content).toBe(APPEARANCE_FALLBACK_COLORS.dark)
    applyAppearance('light')
    expect(themeColorMeta()?.content).toBe(APPEARANCE_FALLBACK_COLORS.light)
    applyAppearance('dark')
    expect(themeColorMeta()?.content).toBe(APPEARANCE_FALLBACK_COLORS.dark)
  })

  test('prefers the resolved page surface over the fallback', () => {
    document.documentElement.style.setProperty('--surface-page', '#123456')
    applyAppearance('light')
    expect(themeColorMeta()?.content).toBe('#123456')
  })

  test('a document without the meta tag still applies the theme', () => {
    themeColorMeta()?.remove()
    expect(() => applyAppearance('light')).not.toThrow()
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
  })
})

describe('appearance control', () => {
  test('exposes an accessible selector in the shell chrome', () => {
    render(<App />)
    const control = screen.getByRole('combobox', { name: 'Appearance' })
    expect(control).toBeVisible()
    expect(control).toHaveValue('system')
    expect(screen.getByRole('option', { name: 'Auto' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Light' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Dark' })).toBeInTheDocument()
  })

  test('choosing light themes the chrome and persists the choice', () => {
    render(<App />)
    const control = screen.getByRole('combobox', { name: 'Appearance' })
    fireEvent.change(control, { target: { value: 'light' } })

    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(readAppearance()).toBe('light')
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toHaveValue('light')
  })

  test('choosing auto hands control back to the operating system', () => {
    // The OS asks for dark, so the default document needs no data-theme.
    setSystemPrefersDark(true)
    render(<App />)
    const control = screen.getByRole('combobox', { name: 'Appearance' })
    fireEvent.change(control, { target: { value: 'light' } })
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')

    // Auto resolves against the OS setting rather than the previous choice.
    fireEvent.change(control, { target: { value: 'system' as Appearance } })
    expect(readAppearance()).toBe('system')
    expect(document.documentElement).not.toHaveAttribute('data-theme')
  })

  test('auto follows a light operating system', () => {
    setSystemPrefersDark(false)
    render(<App />)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(screen.getByRole('combobox', { name: 'Appearance' })).toHaveValue('system')
  })
})
