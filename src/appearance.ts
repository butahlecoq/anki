/*
 * Appearance preference for issue #23.
 *
 * Card content renders inside a sandboxed iframe with its own stylesheet, so
 * this preference cannot reach an imported deck's rules. It supplies the card's
 * *default* surface and ink for a deck that names neither; a note type that sets
 * its own background still wins, because the themed values are declared on
 * `:root` as custom properties and the deck's CSS is appended after them. See
 * src/TemplatePreview.tsx.
 *
 * The default stays dark so the installed PWA matches the manifest colors
 * asserted by tests/e2e/shell.spec.ts.
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
  applyThemeAttribute(theme, root)
  applyThemeColor(theme, root)
}

/**
 * States the theme on a document as `data-theme`, with dark as its absence.
 *
 * This is the whole of the theme convention, so it lives here once. The card
 * frame is a separate document that this module cannot reach, and it needs the
 * same convention or the two documents disagree about which block of custom
 * properties applies. See src/TemplatePreview.tsx.
 */
export function applyThemeAttribute(theme: 'light' | 'dark', root: HTMLElement): void {
  if (theme === 'dark') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
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
 * Subscribes to the resolved theme and calls `publish` with it.
 *
 * One subscription serves both callers; what they do with the theme is theirs.
 * The listeners, and the reason storage is re-read on every notification rather
 * than captured once, are stated here so neither caller restates them.
 */
function subscribeToResolvedTheme(publish: (theme: 'light' | 'dark') => void): () => void {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)')
  // Always re-read storage so a choice made in another tab, or a storage write
  // that happened before this effect ran, is not ignored.
  const notify = () => publish(resolveAppearance(readAppearance(), query?.matches ?? true))
  const onSystemChange = () => notify()
  const onPreferenceChange = () => notify()
  const onStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_STORAGE_KEY) notify()
  }
  notify()
  query?.addEventListener('change', onSystemChange)
  window.addEventListener(APPEARANCE_STORAGE_KEY, onPreferenceChange)
  window.addEventListener('storage', onStorage)
  return () => {
    query?.removeEventListener('change', onSystemChange)
    window.removeEventListener(APPEARANCE_STORAGE_KEY, onPreferenceChange)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * Subscribes to appearance changes and keeps the document attribute in sync
 * with both the stored preference and the OS setting.
 */
export function watchAppearance(onChange?: (theme: 'light' | 'dark') => void): () => void {
  return subscribeToResolvedTheme((theme) => {
    applyAppearance(theme)
    onChange?.(theme)
  })
}

/**
 * Subscribes to the resolved theme *without* re-applying it to this document.
 *
 * A sandboxed card iframe is a separate document, so it has to be told which
 * theme is on screen rather than read it. This reports the resolved theme and
 * leaves the host document alone, which is what a subscriber that only paints
 * something else needs; `watchAppearance` is the one that owns the host.
 */
export function watchResolvedTheme(onChange: (theme: 'light' | 'dark') => void): () => void {
  return subscribeToResolvedTheme(onChange)
}

/** Applies and persists a learner choice, notifying any active watcher. */
export function chooseAppearance(preference: Appearance): void {
  storeAppearance(preference)
  window.dispatchEvent(new CustomEvent<Appearance>(APPEARANCE_STORAGE_KEY, { detail: preference }))
}
