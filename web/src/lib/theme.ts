/** Theme preference handling: system (default), light, or dark. */

export type ThemeMode = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'burley:theme'

export function storedThemeMode(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    /* localStorage unavailable */
  }
  return 'system'
}

export function storeThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* ignore */
  }
}

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

export function resolvedTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode
  return systemPrefersDark() ? 'dark' : 'light'
}

/** Apply the theme to <html> so CSS variables and color-scheme update. */
export function applyTheme(mode: ThemeMode): void {
  const resolved = resolvedTheme(mode)
  const root = document.documentElement
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('burley:themechange', { detail: { theme: resolved } }))
  }
}

/** Subscribe to OS theme changes. Returns an unsubscribe function. */
export function watchSystemTheme(callback: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system'
}
