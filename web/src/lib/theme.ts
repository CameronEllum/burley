/** Theme preference handling: system (default), light, or dark, plus UI palettes. */

export type ThemeMode = 'system' | 'light' | 'dark'
export type LightPalette = 'parchment' | 'white'
export type DarkPalette = 'ember' | 'black'

export interface UiPalette<T extends string> {
  id: T
  name: string
  description: string
  /** Small preview colours shown in Settings. */
  swatch: { app: string; chrome: string; accent: string; border: string }
}

/** Light palettes, each applied only while the resolved theme is light. */
export const LIGHT_THEMES: readonly UiPalette<LightPalette>[] = [
  {
    id: 'parchment',
    name: 'Parchment',
    description: 'Warm paper and ink — the Burley default',
    swatch: { app: '#fbfaf7', chrome: '#f6f3ed', accent: '#c2410c', border: '#e6e0d5' },
  },
  {
    id: 'white',
    name: 'White',
    description: 'Pure white surfaces with neutral greys',
    swatch: { app: '#ffffff', chrome: '#ffffff', accent: '#c2410c', border: '#e4e4e7' },
  },
]

/** Dark palettes, each applied only while the resolved theme is dark. */
export const DARK_THEMES: readonly UiPalette<DarkPalette>[] = [
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm charcoal — the Burley default',
    swatch: { app: '#17140f', chrome: '#1c1813', accent: '#ea580c', border: '#2f2921' },
  },
  {
    id: 'black',
    name: 'Black',
    description: 'Near-black surfaces with brighter rust accents',
    swatch: { app: '#050505', chrome: '#0b0b0b', accent: '#f97316', border: '#232323' },
  },
]

const MODE_KEY = 'burley:theme'
const LIGHT_KEY = 'burley:light-theme'
const DARK_KEY = 'burley:dark-theme'

export function storedThemeMode(): ThemeMode {
  try {
    const value = localStorage.getItem(MODE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    /* localStorage unavailable */
  }
  return 'system'
}

export function storeThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    /* ignore */
  }
}

export function isLightPalette(value: string | null | undefined): value is LightPalette {
  return value === 'parchment' || value === 'white'
}

export function isDarkPalette(value: string | null | undefined): value is DarkPalette {
  return value === 'ember' || value === 'black'
}

export function storedLightPalette(): LightPalette {
  try {
    const value = localStorage.getItem(LIGHT_KEY)
    if (isLightPalette(value)) return value
  } catch {
    /* ignore */
  }
  return 'parchment'
}

export function storedDarkPalette(): DarkPalette {
  try {
    const value = localStorage.getItem(DARK_KEY)
    if (isDarkPalette(value)) return value
  } catch {
    /* ignore */
  }
  return 'ember'
}

export function storePalettes(light: LightPalette, dark: DarkPalette): void {
  try {
    localStorage.setItem(LIGHT_KEY, light)
    localStorage.setItem(DARK_KEY, dark)
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

/**
 * Apply the resolved theme and its configured palette to <html>, so CSS
 * variables and `color-scheme` update together.
 */
export function applyTheme(
  mode: ThemeMode,
  lightTheme: LightPalette = storedLightPalette(),
  darkTheme: DarkPalette = storedDarkPalette(),
): void {
  const resolved = resolvedTheme(mode)
  const palette = resolved === 'light' ? lightTheme : darkTheme
  const root = document.documentElement
  root.dataset.theme = resolved
  root.dataset.palette = palette
  root.style.colorScheme = resolved
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('burley:themechange', { detail: { theme: resolved, palette } }),
    )
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
