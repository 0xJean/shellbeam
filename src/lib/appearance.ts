import { useSyncExternalStore } from 'react'

/**
 * Colour palette and accent preferences. Each family (dark / light) keeps its
 * own palette and accent so switching the theme mode never loses a choice; the
 * matching CSS lives in src/styles/theme-palettes.css and keys off the
 * data-{dark,light}-{palette,accent} attributes on <html>.
 */
export type ThemeFamily = 'dark' | 'light'
export type DarkPalette =
  | 'obsidian'
  | 'tokyo-night'
  | 'catppuccin'
  | 'rose-pine'
  | 'nord'
  | 'graphite'
  | 'emerald-ops'
  | 'solarized-dark'
export type LightPalette =
  | 'obsidian-light'
  | 'tokyo-night-light'
  | 'catppuccin-light'
  | 'rose-pine-light'
  | 'nord-light'
  | 'graphite-light'
  | 'emerald-ops-light'
  | 'solarized'
export type Palette = DarkPalette | LightPalette
export type Accent = 'violet' | 'blue' | 'cyan' | 'teal' | 'green' | 'amber' | 'orange' | 'pink'
/** Geometry and depth (radius, borders, shadows, glass); 'auto' pairs outline with dark and elevated with light. */
export type UiStyle = 'auto' | 'outline' | 'elevated' | 'glass' | 'sharp'
export const UI_STYLES: readonly Exclude<UiStyle, 'auto'>[] = ['outline', 'elevated', 'glass', 'sharp']

export interface AppearancePrefs {
  darkPalette: DarkPalette
  lightPalette: LightPalette
  /** null follows the palette's own default accent. */
  darkAccent: Accent | null
  lightAccent: Accent | null
  uiStyle: UiStyle
}

export interface PaletteMeta {
  family: ThemeFamily
  label: string
  accent: Accent
  /** [canvas, card, signatureAccent] */
  swatch: [string, string, string]
  /** Rich miniature workbench preview colours for the Appearance gallery. */
  preview: {
    frame: string
    canvas: string
    card: string
    accent: string
    line1: string
    line2: string
    line3: string
  }
}

export const PALETTES: Record<Palette, PaletteMeta> = {
  obsidian: {
    family: 'dark', label: 'Obsidian', accent: 'blue',
    swatch: ['#10131b', '#161b26', '#5e8bff'],
    preview: { frame: '#0b0d12', canvas: '#10131b', card: '#161b26', accent: '#5e8bff', line1: '#34d399', line2: '#94a3b8', line3: '#38bdf8' },
  },
  'tokyo-night': {
    family: 'dark', label: 'Tokyo Night', accent: 'blue',
    swatch: ['#1a1b26', '#222436', '#7aa2f7'],
    preview: { frame: '#13141c', canvas: '#1a1b26', card: '#222436', accent: '#7aa2f7', line1: '#9ece6a', line2: '#bb9af7', line3: '#7dcfff' },
  },
  catppuccin: {
    family: 'dark', label: 'Catppuccin', accent: 'violet',
    swatch: ['#1e1e2e', '#26263a', '#b4befe'],
    preview: { frame: '#161622', canvas: '#1e1e2e', card: '#26263a', accent: '#b4befe', line1: '#a6e3a1', line2: '#f9e2af', line3: '#89dceb' },
  },
  'rose-pine': {
    family: 'dark', label: 'Rose Pine', accent: 'pink',
    swatch: ['#191724', '#221f31', '#ebbcba'],
    preview: { frame: '#14121d', canvas: '#191724', card: '#221f31', accent: '#ebbcba', line1: '#9ccfd8', line2: '#f6c177', line3: '#c4a7e7' },
  },
  nord: {
    family: 'dark', label: 'Nord', accent: 'cyan',
    swatch: ['#222733', '#2a303e', '#88c0d0'],
    preview: { frame: '#1b1f28', canvas: '#222733', card: '#2a303e', accent: '#88c0d0', line1: '#a3be8c', line2: '#ebcb8b', line3: '#81a1c1' },
  },
  graphite: {
    family: 'dark', label: 'Graphite', accent: 'amber',
    swatch: ['#1a1816', '#23211d', '#e5a93c'],
    preview: { frame: '#131210', canvas: '#1a1816', card: '#23211d', accent: '#e5a93c', line1: '#8ec07c', line2: '#fabd2f', line3: '#83a598' },
  },
  'emerald-ops': {
    family: 'dark', label: 'Emerald Ops', accent: 'green',
    swatch: ['#101a17', '#172420', '#34d399'],
    preview: { frame: '#0b1210', canvas: '#101a17', card: '#172420', accent: '#34d399', line1: '#34d399', line2: '#7fa195', line3: '#38bdf8' },
  },
  'solarized-dark': {
    family: 'dark', label: 'Solarized', accent: 'teal',
    swatch: ['#002b36', '#073642', '#2aa198'],
    preview: { frame: '#00212a', canvas: '#002b36', card: '#073642', accent: '#2aa198', line1: '#859900', line2: '#b58900', line3: '#268bd2' },
  },
  'obsidian-light': {
    family: 'light', label: 'Obsidian', accent: 'blue',
    swatch: ['#f7f8fb', '#ffffff', '#2563eb'],
    preview: { frame: '#eef1f6', canvas: '#f7f8fb', card: '#ffffff', accent: '#2563eb', line1: '#059669', line2: '#64748b', line3: '#0284c7' },
  },
  'tokyo-night-light': {
    family: 'light', label: 'Tokyo Night', accent: 'blue',
    swatch: ['#f1f2f7', '#fafbfd', '#2e7de9'],
    preview: { frame: '#e4e6ee', canvas: '#f1f2f7', card: '#fafbfd', accent: '#2e7de9', line1: '#587539', line2: '#7847bd', line3: '#007197' },
  },
  'catppuccin-light': {
    family: 'light', label: 'Catppuccin', accent: 'violet',
    swatch: ['#eff1f5', '#fafbfe', '#7287fd'],
    preview: { frame: '#e6e9ef', canvas: '#eff1f5', card: '#fafbfe', accent: '#7287fd', line1: '#40a02b', line2: '#df8e1d', line3: '#04a5e5' },
  },
  'rose-pine-light': {
    family: 'light', label: 'Rose Pine', accent: 'pink',
    swatch: ['#faf4ed', '#fffdf9', '#b4637a'],
    preview: { frame: '#f2e9de', canvas: '#faf4ed', card: '#fffdf9', accent: '#b4637a', line1: '#286983', line2: '#ea9d34', line3: '#907aa9' },
  },
  'nord-light': {
    family: 'light', label: 'Nord', accent: 'cyan',
    swatch: ['#eef1f6', '#f9fafc', '#0e7490'],
    preview: { frame: '#e5e9f0', canvas: '#eef1f6', card: '#f9fafc', accent: '#0e7490', line1: '#5a7a47', line2: '#a87c24', line3: '#3b6ea5' },
  },
  'graphite-light': {
    family: 'light', label: 'Graphite', accent: 'amber',
    swatch: ['#f6f2ea', '#fffdf9', '#b45309'],
    preview: { frame: '#ede7dc', canvas: '#f6f2ea', card: '#fffdf9', accent: '#b45309', line1: '#4d7c3f', line2: '#b45309', line3: '#2d6f7a' },
  },
  'emerald-ops-light': {
    family: 'light', label: 'Emerald Ops', accent: 'green',
    swatch: ['#f2f7f5', '#fbfdfc', '#059669'],
    preview: { frame: '#e7f0ec', canvas: '#f2f7f5', card: '#fbfdfc', accent: '#059669', line1: '#059669', line2: '#547368', line3: '#0284c7' },
  },
  solarized: {
    family: 'light', label: 'Solarized', accent: 'teal',
    swatch: ['#f8f1dc', '#fdf6e3', '#0f766e'],
    preview: { frame: '#ede7d3', canvas: '#f8f1dc', card: '#fdf6e3', accent: '#0f766e', line1: '#6c7c00', line2: '#a67a00', line3: '#1e74b5' },
  },
}

/** A theme is one look with a dark and a light side; the light/dark mode picks the side. */
export const THEMES: readonly { id: string; label: string; dark: DarkPalette; light: LightPalette }[] = [
  { id: 'obsidian', label: 'Obsidian', dark: 'obsidian', light: 'obsidian-light' },
  { id: 'tokyo-night', label: 'Tokyo Night', dark: 'tokyo-night', light: 'tokyo-night-light' },
  { id: 'catppuccin', label: 'Catppuccin', dark: 'catppuccin', light: 'catppuccin-light' },
  { id: 'rose-pine', label: 'Rose Pine', dark: 'rose-pine', light: 'rose-pine-light' },
  { id: 'nord', label: 'Nord', dark: 'nord', light: 'nord-light' },
  { id: 'graphite', label: 'Graphite', dark: 'graphite', light: 'graphite-light' },
  { id: 'emerald-ops', label: 'Emerald Ops', dark: 'emerald-ops', light: 'emerald-ops-light' },
  { id: 'solarized', label: 'Solarized', dark: 'solarized-dark', light: 'solarized' },
]

export const ACCENTS: Record<Accent, string> = {
  violet: '#8b7cf8', blue: '#5e8bff', cyan: '#38bdf8', teal: '#2dd4bf', green: '#34d399', amber: '#e5a93c', orange: '#fb923c', pink: '#f472b6',
}

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  darkPalette: 'obsidian',
  lightPalette: 'obsidian-light',
  darkAccent: null,
  lightAccent: null,
  uiStyle: 'auto',
}

const STORAGE_KEY = 'shellbeam.appearance'

/** Seamless migration map for users upgrading from v3 palette identifiers. */
const LEGACY_DARK_PALETTES: Record<string, DarkPalette> = {
  'aqua-dark': 'obsidian',
  midnight: 'catppuccin',
  dracula: 'rose-pine',
  ocean: 'tokyo-night',
  'mist-dark': 'emerald-ops',
}
const LEGACY_LIGHT_PALETTES: Record<string, LightPalette> = {
  aqua: 'obsidian-light',
  lavender: 'catppuccin-light',
  'dracula-light': 'rose-pine-light',
  'ocean-light': 'tokyo-night-light',
  paper: 'graphite-light',
  mist: 'emerald-ops-light',
}

function resolveSavedPalette<T extends Palette>(value: unknown, family: ThemeFamily, fallback: T): T {
  if (typeof value !== 'string') return fallback
  if (value in PALETTES && PALETTES[value as Palette].family === family) return value as T
  const migrated = family === 'dark' ? LEGACY_DARK_PALETTES[value] : LEGACY_LIGHT_PALETTES[value]
  return (migrated as T | undefined) ?? fallback
}

function isAccent(value: unknown): value is Accent {
  return typeof value === 'string' && value in ACCENTS
}

export function loadAppearance(): AppearancePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<AppearancePrefs> | null
    if (!raw || typeof raw !== 'object') return DEFAULT_APPEARANCE
    return {
      darkPalette: resolveSavedPalette(raw.darkPalette, 'dark', DEFAULT_APPEARANCE.darkPalette),
      lightPalette: resolveSavedPalette(raw.lightPalette, 'light', DEFAULT_APPEARANCE.lightPalette),
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
