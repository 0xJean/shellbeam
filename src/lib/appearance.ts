import { useSyncExternalStore } from 'react'

/**
 * Colour palette and accent preferences. Each family (dark / light) keeps its
 * own palette and accent so switching the theme mode never loses a choice; the
 * matching CSS lives in src/styles/theme-palettes.css and keys off the
 * data-{dark,light}-{palette,accent} attributes on <html>.
 */
export type ThemeFamily = 'dark' | 'light'
export type DarkPalette = 'aqua-dark' | 'midnight' | 'nord' | 'dracula' | 'graphite' | 'ocean' | 'solarized-dark' | 'mist-dark'
export type LightPalette = 'aqua' | 'paper' | 'solarized' | 'mist' | 'lavender' | 'nord-light' | 'dracula-light' | 'ocean-light'
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
  'aqua-dark': { family: 'dark', label: 'Aqua Dark', accent: 'blue', swatch: ['#000000', '#111113', '#0a84ff'] },
  midnight: { family: 'dark', label: 'Midnight', accent: 'violet', swatch: ['#0b0c13', '#15161f', '#6f5ef0'] },
  nord: { family: 'dark', label: 'Nord', accent: 'cyan', swatch: ['#1e222a', '#262b35', '#22b8d6'] },
  dracula: { family: 'dark', label: 'Dracula', accent: 'pink', swatch: ['#1a1b23', '#22232e', '#ec5fa8'] },
  graphite: { family: 'dark', label: 'Graphite', accent: 'amber', swatch: ['#181614', '#242220', '#e3a43c'] },
  ocean: { family: 'dark', label: 'Ocean', accent: 'blue', swatch: ['#08162a', '#11263f', '#2870e4'] },
  'solarized-dark': { family: 'dark', label: 'Solarized', accent: 'teal', swatch: ['#002b36', '#073642', '#2bb5a0'] },
  'mist-dark': { family: 'dark', label: 'Mist', accent: 'green', swatch: ['#121a18', '#1c2825', '#2fbf7d'] },
  aqua: { family: 'light', label: 'Aqua', accent: 'blue', swatch: ['#ededf0', '#ffffff', '#0a84ff'] },
  paper: { family: 'light', label: 'Paper', accent: 'orange', swatch: ['#ebe3d4', '#fffdf8', '#c25200'] },
  solarized: { family: 'light', label: 'Solarized', accent: 'teal', swatch: ['#e8e1cb', '#fdf6e3', '#0d8277'] },
  mist: { family: 'light', label: 'Mist', accent: 'green', swatch: ['#e4ebe8', '#ffffff', '#147f4b'] },
  lavender: { family: 'light', label: 'Lavender', accent: 'violet', swatch: ['#e8e4f6', '#ffffff', '#6e5ce6'] },
  'nord-light': { family: 'light', label: 'Nord', accent: 'cyan', swatch: ['#e5e9f0', '#ffffff', '#0a7f9c'] },
  'dracula-light': { family: 'light', label: 'Dracula', accent: 'pink', swatch: ['#eae5f1', '#ffffff', '#cc3575'] },
  'ocean-light': { family: 'light', label: 'Ocean', accent: 'blue', swatch: ['#dfeaf7', '#ffffff', '#0a84ff'] },
}

/** A theme is one look with a dark and a light side; the light/dark mode picks the side. */
export const THEMES: readonly { id: string; label: string; dark: DarkPalette; light: LightPalette }[] = [
  { id: 'aqua', label: 'Aqua', dark: 'aqua-dark', light: 'aqua' },
  { id: 'midnight', label: 'Midnight', dark: 'midnight', light: 'lavender' },
  { id: 'nord', label: 'Nord', dark: 'nord', light: 'nord-light' },
  { id: 'dracula', label: 'Dracula', dark: 'dracula', light: 'dracula-light' },
  { id: 'graphite', label: 'Graphite', dark: 'graphite', light: 'paper' },
  { id: 'ocean', label: 'Ocean', dark: 'ocean', light: 'ocean-light' },
  { id: 'solarized', label: 'Solarized', dark: 'solarized-dark', light: 'solarized' },
  { id: 'mist', label: 'Mist', dark: 'mist-dark', light: 'mist' },
]

export const ACCENTS: Record<Accent, string> = {
  violet: '#6f5ef0', blue: '#2870e4', cyan: '#22b8d6', teal: '#2bb5a0', green: '#2fbf7d', amber: '#e3a43c', orange: '#f2853a', pink: '#ec5fa8',
}

export const DEFAULT_APPEARANCE: AppearancePrefs = { darkPalette: 'aqua-dark', lightPalette: 'aqua', darkAccent: null, lightAccent: null, uiStyle: 'auto' }

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
