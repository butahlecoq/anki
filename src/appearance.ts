/*
 * Appearance preference for issue #23.
 *
 * Only application chrome is themed. Card content renders inside a sandboxed
 * iframe with its own stylesheet, so this preference never rewrites imported
 * card styling. The default stays dark so the installed PWA matches the
 * manifest colors asserted by tests/e2e/shell.spec.ts.
 */

export const APPEARANCE_STORAGE_KEY = 'kiroku:appearance'

/*
 * Fallback page colours, used only when the stylesheet has not resolved
 * `--surface-page` yet. src/design-tokens.test.ts pins these to the token so
 * the two cannot drift apart.
 */
export const APPEARANCE_FALLBACK_COLORS = { dark: '#0b0d10', light: '#f7f8f6' } as const

export type Appearance = 'system' | 'light' | 'dark'

export function readAppearance(storage: Storage | undefined = safeStorage()): Appearance {
  try {
    const value = storage?.getItem(APPEARANCE_STORAGE_KEY)
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
  } catch {
    // A blocked or full storage must not prevent the shell from rendering.
    return 'system'
  }
}

/** Resolves a stored preference against the current OS setting. */
export function resolveAppearance(preference: Appearance, prefersDark: boolean): 'light' | 'dark' {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

export function applyAppearance(theme: 'light' | 'dark', root: HTMLElement = document.documentElement): void {
  if (theme === 'dark') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  applyThemeColor(theme, root)
}

/**
 * Keeps the browser chrome in step with the theme actually on screen.
 *
 * `<meta name="theme-color">` is what an installed iPhone app paints its status
 * bar with, so leaving it on the dark default would put white status-bar text
 * over the light page. The value is read from the `--surface-page` token rather
 * than hardcoded, so the status bar can never disagree with the page.
 *
 * This deliberately does not touch the web app manifest: `theme_color` there
 * describes the install prompt and the splash screen, which stay dark, and
 * tests/e2e/shell.spec.ts asserts that.
 */
export function applyThemeColor(theme: 'light' | 'dark', root: HTMLElement = document.documentElement): void {
  const meta = root.ownerDocument.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) return
  const token = window.getComputedStyle(root).getPropertyValue('--surface-page').trim()
  meta.content = token || APPEARANCE_FALLBACK_COLORS[theme]
}

export function storeAppearance(preference: Appearance, storage: Storage | undefined = safeStorage()): void {
  try {
    storage?.setItem(APPEARANCE_STORAGE_KEY, preference)
  } catch {
    // A rejected write only means the choice will not survive a reload.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/**
 * Subscribes to appearance changes and keeps the document attribute in sync
 * with both the stored preference and the OS setting.
 */
export function watchAppearance(onChange?: (theme: 'light' | 'dark') => void): () => void {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)')
  // Always re-read storage so a choice made in another tab, or a storage write
  // that happened before this effect ran, is not ignored.
  const publish = () => {
    const theme = resolveAppearance(readAppearance(), query?.matches ?? true)
    applyAppearance(theme)
    onChange?.(theme)
  }
  const onSystemChange = () => publish()
  const onPreferenceChange = () => publish()
  const onStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_STORAGE_KEY) publish()
  }
  publish()
  query?.addEventListener('change', onSystemChange)
  window.addEventListener(APPEARANCE_STORAGE_KEY, onPreferenceChange)
  window.addEventListener('storage', onStorage)
  return () => {
    query?.removeEventListener('change', onSystemChange)
    window.removeEventListener(APPEARANCE_STORAGE_KEY, onPreferenceChange)
    window.removeEventListener('storage', onStorage)
  }
}

/** Applies and persists a learner choice, notifying any active watcher. */
export function chooseAppearance(preference: Appearance): void {
  storeAppearance(preference)
  window.dispatchEvent(new CustomEvent<Appearance>(APPEARANCE_STORAGE_KEY, { detail: preference }))
}
