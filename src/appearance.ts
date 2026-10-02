/*
 * Appearance preference for issue #23.
 *
 * Only application chrome is themed. Card content renders inside a sandboxed
 * iframe with its own stylesheet, so this preference never rewrites imported
 * card styling. The default stays dark so the installed PWA matches the
 * manifest colors asserted by tests/e2e/shell.spec.ts.
 */

export const APPEARANCE_STORAGE_KEY = 'kiroku:appearance'

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
