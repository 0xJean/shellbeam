import { useSyncExternalStore } from 'react'

/**
 * Colour palette and accent preferences. Each family (dark / light) keeps its
 * own palette and accent so switching the theme mode never loses a choice; the
 * matching CSS lives in src/styles/theme-palettes.css and keys off the
 * data-{dark,light}-{palette,accent} attributes on <html>.
 */
export type ThemeFamily = 'dark' | 'light'
export type DarkPalette = 'midnight' | 'nord' | 'dracula' | 'graphite' | 'ocean'
export type LightPalette = 'aqua' | 'paper' | 'solarized' | 'mist' | 'lavender'
export type Palette = DarkPalette | LightPalette
export type Accent = 'violet' | 'blue' | 'cyan' | 'teal' | 'green' | 'amber' | 'orange' | 'pink'
/** Geometry and depth (radius, borders, shadows); 'auto' pairs outline with dark and elevated with light. */
export type UiStyle = 'auto' | 'outline' | 'elevated' | 'sharp'
export const UI_STYLES: readonly Exclude<UiStyle, 'auto'>[] = ['outline', 'elevated', 'sharp']

export interface AppearancePrefs {
  darkPalette: DarkPalette
  lightPalette: LightPalette
  /** null follows the palette's own default accent. */
  darkAccent: Accent | null
  lightAccent: Accent | null
  uiStyle: UiStyle
}

export const PALETTES: Record<Palette, { family: ThemeFamily; label: string; accent: Accent; swatch: [string, string, string] }> = {
  midnight: { family: 'dark', label: 'Midnight', accent: 'violet', swatch: ['#0f1013', '#16171c', '#7c6cf2'] },
  nord: { family: 'dark', label: 'Nord', accent: 'cyan', swatch: ['#242933', '#2e3440', '#22b8d6'] },
  dracula: { family: 'dark', label: 'Dracula', accent: 'pink', swatch: ['#21222c', '#2b2d3a', '#ec5fa8'] },
  graphite: { family: 'dark', label: 'Graphite', accent: 'amber', swatch: ['#161514', '#201f1d', '#e3a43c'] },
  ocean: { family: 'dark', label: 'Ocean', accent: 'blue', swatch: ['#0b1220', '#121c30', '#3b8bff'] },
  aqua: { family: 'light', label: 'Aqua', accent: 'blue', swatch: ['#f5f5f7', '#ffffff', '#0a84ff'] },
  paper: { family: 'light', label: 'Paper', accent: 'orange', swatch: ['#f4efe6', '#fffdf8', '#f2700d'] },
  solarized: { family: 'light', label: 'Solarized', accent: 'teal', swatch: ['#eee8d5', '#fffaeb', '#0f9488'] },
  mist: { family: 'light', label: 'Mist', accent: 'green', swatch: ['#eef2f1', '#ffffff', '#1fa463'] },
  lavender: { family: 'light', label: 'Lavender', accent: 'violet', swatch: ['#f3f1fa', '#ffffff', '#6e5ce6'] },
}

export const ACCENTS: Record<Accent, string> = {
  violet: '#7c6cf2', blue: '#3b8bff', cyan: '#22b8d6', teal: '#2bb5a0', green: '#2fbf7d', amber: '#e3a43c', orange: '#f2853a', pink: '#ec5fa8',
}

export const DEFAULT_APPEARANCE: AppearancePrefs = { darkPalette: 'midnight', lightPalette: 'aqua', darkAccent: null, lightAccent: null, uiStyle: 'auto' }

const STORAGE_KEY = 'shellbeam.appearance'

function isPalette(value: unknown, family: ThemeFamily): value is Palette {
  return typeof value === 'string' && value in PALETTES && PALETTES[value as Palette].family === family
}

function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && value in ACCENTS
}

export function loadAppearance(): AppearancePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<AppearancePrefs> | null
    if (!raw || typeof raw !== 'object') return DEFAULT_APPEARANCE
    return {
      darkPalette: isPalette(raw.darkPalette, 'dark') ? (raw.darkPalette as DarkPalette) : DEFAULT_APPEARANCE.darkPalette,
      lightPalette: isPalette(raw.lightPalette, 'light') ? (raw.lightPalette as LightPalette) : DEFAULT_APPEARANCE.lightPalette,
      darkAccent: isAccent(raw.darkAccent) ? raw.darkAccent : null,
      lightAccent: isAccent(raw.lightAccent) ? raw.lightAccent : null,
      uiStyle: raw.uiStyle === 'auto' || UI_STYLES.includes(raw.uiStyle as never) ? (raw.uiStyle as UiStyle) : 'auto',
    }
  } catch {
    return DEFAULT_APPEARANCE
  }
}

export function resolveAccent(prefs: AppearancePrefs, family: ThemeFamily): Accent {
  return family === 'dark' ? prefs.darkAccent ?? PALETTES[prefs.darkPalette].accent : prefs.lightAccent ?? PALETTES[prefs.lightPalette].accent
}

export function resolveUiStyle(prefs: AppearancePrefs, family: ThemeFamily): Exclude<UiStyle, 'auto'> {
  if (prefs.uiStyle !== 'auto') return prefs.uiStyle
  return family === 'dark' ? 'outline' : 'elevated'
}

export function applyAppearance(prefs: AppearancePrefs, root: HTMLElement = document.documentElement) {
  root.dataset.darkPalette = prefs.darkPalette
  root.dataset.lightPalette = prefs.lightPalette
  root.dataset.darkAccent = resolveAccent(prefs, 'dark')
  root.dataset.lightAccent = resolveAccent(prefs, 'light')
  root.dataset.darkStyle = resolveUiStyle(prefs, 'dark')
  root.dataset.lightStyle = resolveUiStyle(prefs, 'light')
}

let current: AppearancePrefs | null = null
const listeners = new Set<() => void>()

function snapshot() {
  if (!current) current = loadAppearance()
  return current
}

export function setAppearance(partial: Partial<AppearancePrefs>) {
  current = { ...snapshot(), ...partial }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  applyAppearance(current)
  listeners.forEach((listener) => listener())
}

/** Apply saved preferences before React renders so the first frame already has the right colours. */
export function initAppearance() {
  applyAppearance(snapshot())
}

export function useAppearance() {
  const prefs = useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, snapshot)
  return { prefs, setAppearance }
}
