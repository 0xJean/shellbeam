import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTheme } from '@/hooks/use-theme'
import { paletteShortcutAction } from '@/lib/palette-shortcuts'
import type { SidebarNavId } from '@/components/pc-nav-sidebar'
import { loadTerminalPrefs, saveTerminalPrefs, type TerminalPrefs } from '@/lib/terminal-themes'

export type CommandPaletteAction = 'focus-sftp' | 'focus-settings' | 'focus-interactive' | 'focus-vaults-dashboard'

interface AppContextValue {
  theme: string
  toggleTheme: () => void
  output: string
  setOutput: (msg: string) => void
  command: string
  setCommand: (cmd: string) => void
  pcSidebarNav: SidebarNavId
  setPcSidebarNav: (n: SidebarNavId) => void
  commandPaletteOpen: boolean
  setCommandPaletteOpen: (open: boolean) => void
  terminalMode: 'command' | 'interactive'
  setTerminalMode: (m: 'command' | 'interactive') => void
  handleCommandPaletteAction: (action: CommandPaletteAction) => void
  terminalPrefs: TerminalPrefs
  updateTerminalPrefs: (partial: Partial<TerminalPrefs>) => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { theme, toggleTheme } = useTheme()
  const [output, setOutput] = useState('Terminal output will appear here...')
  const [command, setCommand] = useState('uname -a')
  const [pcSidebarNav, setPcSidebarNav] = useState<SidebarNavId>('hosts')
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [terminalMode, setTerminalMode] = useState<'command' | 'interactive'>('command')
  const [terminalPrefs, setTerminalPrefs] = useState<TerminalPrefs>(loadTerminalPrefs)

  const updateTerminalPrefs = useCallback((partial: Partial<TerminalPrefs>) => {
    setTerminalPrefs((prev) => {
      const next = { ...prev, ...partial }
      saveTerminalPrefs(next)
      return next
    })
  }, [])

  const handlePaletteActionRef = useRef<(action: CommandPaletteAction) => void>(() => {})
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'j')) {
        e.preventDefault()
        setCommandPaletteOpen((p) => !p)
        return
      }
      const action = paletteShortcutAction(e)
      if (action) {
        e.preventDefault()
        handlePaletteActionRef.current(action)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleCommandPaletteAction = useCallback((action: CommandPaletteAction) => {
    setCommandPaletteOpen(false)
    if (action === 'focus-sftp') setPcSidebarNav('sftp')
    else if (action === 'focus-settings') setPcSidebarNav('settings')
    else if (action === 'focus-vaults-dashboard') setPcSidebarNav('keychain')
    else if (action === 'focus-interactive') setTerminalMode('interactive')
  }, [])

  useEffect(() => { handlePaletteActionRef.current = handleCommandPaletteAction }, [handleCommandPaletteAction])

  const value = useMemo(() => ({
    theme, toggleTheme, output, setOutput, command, setCommand,
    pcSidebarNav, setPcSidebarNav,
    commandPaletteOpen, setCommandPaletteOpen,
    terminalMode, setTerminalMode,
    handleCommandPaletteAction,
    terminalPrefs, updateTerminalPrefs,
  }), [
    command,
    commandPaletteOpen,
    handleCommandPaletteAction,
    output,
    pcSidebarNav,
    terminalMode,
    terminalPrefs,
    theme,
    toggleTheme,
    updateTerminalPrefs,
  ])

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  )
}
