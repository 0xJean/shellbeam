import type { ITheme } from '@xterm/xterm'

export interface TerminalPrefs {
  fontSize: number
  fontFamily: string
  themeId: string
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = {
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, 'SFMono-Regular', 'SF Mono', Menlo, Monaco, 'Courier New', monospace",
  themeId: 'hacker-green',
}

export interface TerminalThemeDef {
  id: string
  name: string
  theme: ITheme
}

export const TERMINAL_THEMES: TerminalThemeDef[] = [
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
    id: 'solarized-dark',
    name: 'Solarized Dark',
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#839496',
      cursorAccent: '#002b36',
      selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
      blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    theme: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
      blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
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
    id: 'light',
    name: 'Light',
    theme: {
      background: '#ffffff',
      foreground: '#383a42',
      cursor: '#526eff',
      cursorAccent: '#ffffff',
      selectionBackground: '#bfceff',
      black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
      blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#a0a1a7',
      brightBlack: '#4f525e', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff',
    },
  },
]

const PREFS_KEY = 'shellbeam.terminalPrefs'

export function loadTerminalPrefs(): TerminalPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return { ...DEFAULT_TERMINAL_PREFS, ...parsed }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_TERMINAL_PREFS }
}

export function saveTerminalPrefs(prefs: TerminalPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

export function getThemeById(id: string): TerminalThemeDef {
  return TERMINAL_THEMES.find((t) => t.id === id) ?? TERMINAL_THEMES[0]
}
