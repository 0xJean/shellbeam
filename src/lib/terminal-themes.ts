import type { ITheme } from '@xterm/xterm'
import { useMemo, useSyncExternalStore } from 'react'
import { ACCENTS, PALETTES, resolveAccent, useAppearance, type AppearancePrefs, type Palette, type ThemeFamily } from './appearance'
import { useT } from './i18n'

export type TerminalCursorStyle = 'block' | 'bar' | 'underline'

export interface TerminalPrefs {
  fontSize: number
  fontFamily: string
  themeId: string
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  /** Colour failures, warnings, successes and addresses in uncoloured output. */
  keywordHighlight?: boolean
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Monaco, 'Courier New', monospace",
  themeId: 'app',
  cursorStyle: 'block',
  cursorBlink: true,
  keywordHighlight: true,
}

export interface TerminalThemeDef {
  id: string
  name: string
  theme: ITheme
}

export const TERMINAL_THEMES: TerminalThemeDef[] = [
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    theme: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#7aa2f7',
      cursorAccent: '#1a1b26',
      selectionBackground: '#33467c',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
      blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#565f89', brightRed: '#ff899d', brightGreen: '#b9f27c', brightYellow: '#ffc777',
      brightBlue: '#8db0ff', brightMagenta: '#c7a9ff', brightCyan: '#a4daff', brightWhite: '#e6ecff',
    },
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#b4befe',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#45475a',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
      blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
      brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#89dceb', brightWhite: '#f5e0dc',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    theme: {
      background: '#1e1e2e',
      foreground: '#abb2bf',
      cursor: '#528bff',
      cursorAccent: '#1e1e2e',
      selectionBackground: '#3e4451',
      black: '#1e1e2e', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
      blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    theme: {
      background: '#222733',
      foreground: '#d8dee9',
      cursor: '#88c0d0',
      cursorAccent: '#222733',
      selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#d06f79', brightGreen: '#b1d196', brightYellow: '#f0d399',
      brightBlue: '#88a9cc', brightMagenta: '#c895bf', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    theme: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
      blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#93a1a1',
      cursor: '#2aa198',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    theme: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      cursorAccent: '#272822',
      selectionBackground: '#49483e',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
      blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75',
      brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  },
  {
    id: 'hacker-green',
    name: 'Hacker Green',
    theme: {
      background: '#000000',
      foreground: '#00ff41',
      cursor: '#00ff41',
      cursorAccent: '#000000',
      selectionBackground: '#00ff4130',
      selectionForeground: '#ffffff',
      black: '#000000', red: '#ff0000', green: '#00ff41', yellow: '#ffff00',
      blue: '#00aaff', magenta: '#ff00ff', cyan: '#00ffff', white: '#c0c0c0',
      brightBlack: '#555555', brightRed: '#ff5555', brightGreen: '#55ff55', brightYellow: '#ffff55',
      brightBlue: '#5555ff', brightMagenta: '#ff55ff', brightCyan: '#55ffff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'light',
    name: 'Light',
    theme: {
      background: '#f7f8fb',
      foreground: '#1e293b',
      cursor: '#2563eb',
      cursorAccent: '#f7f8fb',
      selectionBackground: '#bfdbfe',
      black: '#1e293b', red: '#dc2626', green: '#059669', yellow: '#b45309',
      blue: '#2563eb', magenta: '#9333ea', cyan: '#0284c7', white: '#94a3b8',
      brightBlack: '#475569', brightRed: '#ef4444', brightGreen: '#10b981', brightYellow: '#d97706',
      brightBlue: '#3b82f6', brightMagenta: '#a855f7', brightCyan: '#0ea5e9', brightWhite: '#ffffff',
    },
  },
]

/** Follows the app: built from the current palette, light/dark mode and accent. */
export const APP_TERMINAL_THEME_ID = 'app'

type AnsiSlice = Pick<
  ITheme,
  | 'foreground'
  | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
  | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'
>

/** Dedicated 16-color ANSI palette per app palette so terminal logs & syntax stay visually harmonized with the chrome. */
const PALETTE_ANSI: Record<Palette, AnsiSlice> = {
  obsidian: {
    foreground: '#d7deed',
    black: '#161b26', red: '#f87171', green: '#34d399', yellow: '#f5b041',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#38bdf8', white: '#cbd5e1',
    brightBlack: '#5e677d', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fcd34d',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#7dd3fc', brightWhite: '#f8fafc',
  },
  'tokyo-night': {
    foreground: '#c0caf5',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#565f89', brightRed: '#ff899d', brightGreen: '#b9f27c', brightYellow: '#ffc777',
    brightBlue: '#8db0ff', brightMagenta: '#c7a9ff', brightCyan: '#a4daff', brightWhite: '#e6ecff',
  },
  catppuccin: {
    foreground: '#cdd6f4',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
    brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#89dceb', brightWhite: '#f5e0dc',
  },
  'rose-pine': {
    foreground: '#e0def4',
    black: '#26233a', red: '#eb6f92', green: '#9ccfd8', yellow: '#f6c177',
    blue: '#31748f', magenta: '#c4a7e7', cyan: '#ebbcba', white: '#e0def4',
    brightBlack: '#6e6a86', brightRed: '#f08aa6', brightGreen: '#b2dce4', brightYellow: '#f8cf95',
    brightBlue: '#4f96b3', brightMagenta: '#d5bef0', brightCyan: '#f2ccc9', brightWhite: '#f3f1fb',
  },
  nord: {
    foreground: '#d8dee9',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
    blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#58637a', brightRed: '#d06f79', brightGreen: '#b1d196', brightYellow: '#f0d399',
    brightBlue: '#88a9cc', brightMagenta: '#c895bf', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  graphite: {
    foreground: '#e5dfd4',
    black: '#282521', red: '#ea6962', green: '#a9b665', yellow: '#e5a93c',
    blue: '#7daea3', magenta: '#d3869b', cyan: '#89b482', white: '#d4be98',
    brightBlack: '#6c655a', brightRed: '#f0847d', brightGreen: '#b8c47a', brightYellow: '#f0bd5e',
    brightBlue: '#93c0b6', brightMagenta: '#e09eb0', brightCyan: '#a0c69a', brightWhite: '#f5f1ea',
  },
  'emerald-ops': {
    foreground: '#d2e7df',
    black: '#172420', red: '#f87171', green: '#34d399', yellow: '#f5b041',
    blue: '#38bdf8', magenta: '#c084fc', cyan: '#2dd4bf', white: '#c5dcd3',
    brightBlack: '#557268', brightRed: '#fca5a5', brightGreen: '#6ee7b7', brightYellow: '#fcd34d',
    brightBlue: '#7dd3fc', brightMagenta: '#d8b4fe', brightCyan: '#5eead4', brightWhite: '#edf7f3',
  },
  'solarized-dark': {
    foreground: '#a5b5b5',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496',
    brightBlue: '#6c9ec4', brightMagenta: '#6c71c4', brightCyan: '#42c4ba', brightWhite: '#fdf6e3',
  },
  'obsidian-light': {
    foreground: '#1e293b',
    black: '#1e293b', red: '#dc2626', green: '#059669', yellow: '#b45309',
    blue: '#2563eb', magenta: '#7c3aed', cyan: '#0284c7', white: '#64748b',
    brightBlack: '#475569', brightRed: '#ef4444', brightGreen: '#10b981', brightYellow: '#d97706',
    brightBlue: '#3b82f6', brightMagenta: '#8b5cf6', brightCyan: '#0ea5e9', brightWhite: '#0f172a',
  },
  'tokyo-night-light': {
    foreground: '#2b3354',
    black: '#1f2335', red: '#c63554', green: '#48702a', yellow: '#8c6c3e',
    blue: '#2e7de9', magenta: '#7847bd', cyan: '#007197', white: '#616d91',
    brightBlack: '#586387', brightRed: '#dc3f60', brightGreen: '#588236', brightYellow: '#a87d32',
    brightBlue: '#3b88f5', brightMagenta: '#8b5ad1', brightCyan: '#0c84ad', brightWhite: '#1f2335',
  },
  'catppuccin-light': {
    foreground: '#4c4f69',
    black: '#4c4f69', red: '#d20f39', green: '#40a02b', yellow: '#df8e1d',
    blue: '#1e66f5', magenta: '#8839ef', cyan: '#179299', white: '#6c6f85',
    brightBlack: '#6c6f85', brightRed: '#e64553', brightGreen: '#4eb038', brightYellow: '#e59a2d',
    brightBlue: '#3878f8', brightMagenta: '#9c52f5', brightCyan: '#04a5e5', brightWhite: '#303246',
  },
  'rose-pine-light': {
    foreground: '#464166',
    black: '#393552', red: '#b4637a', green: '#286983', yellow: '#c48322',
    blue: '#3e8fb0', magenta: '#907aa9', cyan: '#d7827e', white: '#797593',
    brightBlack: '#6e6a86', brightRed: '#c96f89', brightGreen: '#337c99', brightYellow: '#d6922d',
    brightBlue: '#4d9ec0', brightMagenta: '#a28cbd', brightCyan: '#e0918d', brightWhite: '#393552',
  },
  'nord-light': {
    foreground: '#2e3440',
    black: '#2e3440', red: '#b54652', green: '#557845', yellow: '#a87c24',
    blue: '#3b6ea5', magenta: '#885e85', cyan: '#0e7490', white: '#67748b',
    brightBlack: '#4c566a', brightRed: '#c85360', brightGreen: '#678d56', brightYellow: '#bf8d2e',
    brightBlue: '#4d82ba', brightMagenta: '#9d709a', brightCyan: '#1487a6', brightWhite: '#242933',
  },
  'graphite-light': {
    foreground: '#3c352b',
    black: '#29241e', red: '#b8322a', green: '#4d7c3f', yellow: '#b45309',
    blue: '#2d6f7a', magenta: '#8f466e', cyan: '#357a62', white: '#756c5e',
    brightBlack: '#5e564a', brightRed: '#cc3e36', brightGreen: '#5e904e', brightYellow: '#c96212',
    brightBlue: '#3a8490', brightMagenta: '#a65480', brightCyan: '#428f74', brightWhite: '#29241e',
  },
  'emerald-ops-light': {
    foreground: '#1e3830',
    black: '#132a23', red: '#dc2626', green: '#059669', yellow: '#b45309',
    blue: '#0284c7', magenta: '#7c3aed', cyan: '#0d9488', white: '#547368',
    brightBlack: '#3d5e53', brightRed: '#ef4444', brightGreen: '#10b981', brightYellow: '#d97706',
    brightBlue: '#0ea5e9', brightMagenta: '#8b5cf6', brightCyan: '#14b8a6', brightWhite: '#132a23',
  },
  solarized: {
    foreground: '#445960',
    black: '#073642', red: '#dc322f', green: '#6c7c00', yellow: '#a67a00',
    blue: '#268bd2', magenta: '#d33682', cyan: '#0f766e', white: '#657b83',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#859900', brightYellow: '#b58900',
    brightBlue: '#3799de', brightMagenta: '#6c71c4', brightCyan: '#2aa198', brightWhite: '#002b36',
  },
}

export function appTerminalTheme(family: ThemeFamily, prefs: AppearancePrefs): ITheme {
  const palette = family === 'dark' ? prefs.darkPalette : prefs.lightPalette
  const background = PALETTES[palette].swatch[0]
  const resolved = resolveAccent(prefs, family)
  // The palette's own accent uses its exact signature swatch colour.
  const accent = resolved === PALETTES[palette].accent ? PALETTES[palette].swatch[2] : ACCENTS[resolved]
  const ansi = PALETTE_ANSI[palette]
  return {
    ...ansi,
    background,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: `${accent}${family === 'dark' ? '38' : '2e'}`,
    selectionForeground: undefined,
  }
}

function subscribeAppFamily(listener: () => void) {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
const appFamily = (): ThemeFamily => document.documentElement.classList.contains('dark') ? 'dark' : 'light'

/** The app's current light/dark mode, read from <html> so it tracks every theme switch. */
export function useAppThemeFamily(): ThemeFamily {
  return useSyncExternalStore(subscribeAppFamily, appFamily)
}

/** Every selectable terminal theme, with "Follow theme" first and resolved for the current app look. */
export function useTerminalThemes(): TerminalThemeDef[] {
  const { t } = useT()
  const family = useAppThemeFamily()
  const { prefs } = useAppearance()
  const name = t('terminal.themeFollowApp')
  return useMemo(() => [{ id: APP_TERMINAL_THEME_ID, name, theme: appTerminalTheme(family, prefs) }, ...TERMINAL_THEMES], [name, family, prefs])
}

/** The xterm theme to draw with for a saved theme id. */
export function useResolvedTerminalTheme(themeId: string | undefined): ITheme {
  const family = useAppThemeFamily()
  const { prefs } = useAppearance()
  const id = themeId ?? DEFAULT_TERMINAL_PREFS.themeId
  return useMemo(() => id === APP_TERMINAL_THEME_ID ? appTerminalTheme(family, prefs) : getThemeById(id).theme, [id, family, prefs])
}

const PREFS_KEY = 'shellbeam.terminalPrefs'
// Version 2 made "Follow theme" the default. Earlier saves always wrote the old
// default 'hacker-green' even when nobody picked it, so that value moves over.
const PREFS_VERSION = 2

export function loadTerminalPrefs(): TerminalPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const prefs = { ...DEFAULT_TERMINAL_PREFS, ...parsed }
      if (parsed.version !== PREFS_VERSION && parsed.themeId === 'hacker-green') prefs.themeId = APP_TERMINAL_THEME_ID
      delete prefs.version
      return prefs
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_TERMINAL_PREFS }
}

export function saveTerminalPrefs(prefs: TerminalPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, version: PREFS_VERSION }))
}

export function getThemeById(id: string): TerminalThemeDef {
  return TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0]
}
