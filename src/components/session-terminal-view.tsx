import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react'
import { useT } from '@/lib/i18n'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { Sparkles, RefreshCw, WifiOff, PanelRightOpen, PanelRightClose } from 'lucide-react'
import type { InteractiveOutputChunk, InteractiveSessionInfo } from '@/lib/interactive-session'
import { resizeInteractiveTerminal } from '@/lib/interactive-session'
import { getThemeById, type TerminalPrefs } from '@/lib/terminal-themes'
import { recordInteractiveCommand } from '@/lib/interactive-history'
import { cn } from '@/lib/utils'
import { MobileTerminalToolbar } from './mobile-terminal-toolbar'
import { AICommandBar } from './ai-command-bar'
import { TerminalSearchBar } from './terminal-search-bar'
import { SuggestBar } from './suggest-bar'

interface SessionTerminalViewProps {
  sessionId: string
  session: InteractiveSessionInfo | null
  hostName: string
  hostAddress: string
  chunkEmitterRef: MutableRefObject<Record<string, (chunks: InteractiveOutputChunk[]) => void>>
  onSendRaw: (data: string) => void
  terminalPrefs?: TerminalPrefs
  isReconnecting?: boolean
  onReconnect?: () => void
  visible?: boolean
  onToggleRightSidebar?: () => void
  rightSidebarOpen?: boolean
}

export function SessionTerminalView({
  sessionId,
  session,
  hostName,
  hostAddress,
  chunkEmitterRef,
  onSendRaw,
  terminalPrefs,
  isReconnecting,
  onReconnect,
  visible = true,
  onToggleRightSidebar,
  rightSidebarOpen,
}: SessionTerminalViewProps) {
  const { t } = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onSendRawRef = useRef(onSendRaw)
  const [showAI, setShowAI] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [currentInputLine, setCurrentInputLine] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputLineRef = useRef('')
  const searchAddonRef = useRef<SearchAddon | null>(null)

  onSendRawRef.current = onSendRaw

  const isConnected = session?.status?.startsWith('running') ?? false
  const isDisconnected = session?.status?.startsWith('closed') ?? false

  const prefsRef = useRef(terminalPrefs)
  prefsRef.current = terminalPrefs

  const getTerminalContext = useCallback(() => {
    const term = termRef.current
    if (!term) return ''
    const buf = term.buffer.active
    const totalRows = buf.length
    const startRow = Math.max(0, totalRows - 20)
    const lines: string[] = []
    for (let i = startRow; i < totalRows; i++) {
      const line = buf.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    return lines.join('\n').trim()
  }, [])

  const handleExecuteCommand = useCallback((cmd: string) => {
    onSendRawRef.current(cmd)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
        e.preventDefault()
        setShowAI((v) => !v)
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setShowSearch((v) => !v)
      }
      if (e.ctrlKey && e.key === ' ') {
        e.preventDefault()
        setShowSuggestions((v) => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const activeTheme = getThemeById(terminalPrefs?.themeId ?? 'hacker-green')
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: terminalPrefs?.fontSize ?? 13,
      fontFamily: terminalPrefs?.fontFamily ?? "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, 'Courier New', monospace",
      lineHeight: 1.2,
      scrollback: 10000,
      fastScrollSensitivity: 10,
      smoothScrollDuration: 0,
      rescaleOverlappingGlyphs: true,
      theme: activeTheme.theme,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => { webgl.dispose() })
      term.loadAddon(webgl)
    } catch {
      // WebGL not available, fall back to canvas renderer
    }

    const search = new SearchAddon()
    term.loadAddon(search)
    searchAddonRef.current = search

    termRef.current = term
    fitRef.current = fit

    let writeWatermark = 0
    const WATERMARK_HIGH = 1 << 18
    const drain = () => { writeWatermark = 0 }

    chunkEmitterRef.current[sessionId] = (chunks) => {
      let batch = ''
      for (let i = 0; i < chunks.length; i++) batch += chunks[i].data

      if (writeWatermark > WATERMARK_HIGH) return
      writeWatermark += batch.length
      term.write(batch, drain)
    }

    const onData = term.onData((data: string) => {
      onSendRawRef.current(data)
      if (data === '\r' || data === '\n') {
        if (inputLineRef.current.trim()) {
          recordInteractiveCommand(hostAddress, inputLineRef.current)
        }
        inputLineRef.current = ''
        setCurrentInputLine('')
        setShowSuggestions(false)
      } else if (data === '\x7f' || data === '\b') {
        inputLineRef.current = inputLineRef.current.slice(0, -1)
        setCurrentInputLine(inputLineRef.current)
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        inputLineRef.current += data
        setCurrentInputLine(inputLineRef.current)
        setShowSuggestions(inputLineRef.current.length >= 2)
      } else {
        inputLineRef.current = ''
        setCurrentInputLine('')
        setShowSuggestions(false)
      }
    })
    const onBinary = term.onBinary((data: string) => {
      onSendRawRef.current(data)
    })

    const onResize = term.onResize(({ cols, rows }) => {
      if (!sessionId.startsWith('pending-')) {
        void resizeInteractiveTerminal(sessionId, cols, rows).catch(() => {})
      }
    })

    let fitTimer: ReturnType<typeof setTimeout> | null = null
    const resizeObs = new ResizeObserver(() => {
      if (fitTimer) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        try { fit.fit() } catch { /* teardown */ }
      }, 50)
    })
    resizeObs.observe(containerRef.current)

    return () => {
      delete chunkEmitterRef.current[sessionId]
      onData.dispose()
      onBinary.dispose()
      onResize.dispose()
      resizeObs.disconnect()
      if (fitTimer) clearTimeout(fitTimer)
      searchAddonRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId, chunkEmitterRef])

  useEffect(() => {
    const term = termRef.current
    if (!term || !terminalPrefs) return
    const themeDef = getThemeById(terminalPrefs.themeId)
    term.options.theme = themeDef.theme
    term.options.fontSize = terminalPrefs.fontSize
    term.options.fontFamily = terminalPrefs.fontFamily
    try { fitRef.current?.fit() } catch { /* teardown */ }
  }, [terminalPrefs?.themeId, terminalPrefs?.fontSize, terminalPrefs?.fontFamily])

  const prevVisibleRef = useRef(visible)
  useEffect(() => {
    const wasHidden = !prevVisibleRef.current
    prevVisibleRef.current = visible
    if (visible && wasHidden) {
      requestAnimationFrame(() => {
        try { fitRef.current?.fit() } catch { /* teardown */ }
        termRef.current?.focus()
      })
    }
  }, [visible])

  const handleContainerClick = useCallback(() => {
    termRef.current?.focus()
  }, [])

  const activeThemeDef = getThemeById(terminalPrefs?.themeId ?? 'hacker-green')
  const bg = activeThemeDef.theme.background ?? '#000000'
  const fg = activeThemeDef.theme.foreground ?? '#00ff41'

  return (
    <div className="relative flex h-full flex-col" style={{ background: bg }}>
      <div className="flex h-9 shrink-0 items-center gap-2 overflow-hidden px-4" style={{ borderBottom: `1px solid ${fg}15` }}>
        <span className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          isConnected ? 'bg-emerald-500' : isReconnecting ? 'bg-amber-500 animate-pulse' : isDisconnected ? 'bg-red-500' : 'bg-gray-500',
        )} />
        <span className="min-w-0 truncate text-xs font-medium" style={{ color: `${fg}cc` }}>
          {session?.username ?? 'root'}@{hostAddress}
          {hostName && <span style={{ color: `${fg}66` }}> ({hostName})</span>}
          {isReconnecting && <span className="ml-2 text-amber-400">{t('terminal.reconnecting')}</span>}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {isConnected && (
            <button
              type="button"
              onClick={() => setShowAI((v) => !v)}
              className={cn(
                'hidden items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold tracking-wide transition-all md:flex',
                showAI
                  ? 'bg-primary/25 text-blue-300 shadow-[0_0_12px_rgba(19,91,236,0.3)]'
                  : 'border border-primary/30 bg-primary/10 text-primary shadow-[0_0_6px_rgba(19,91,236,0.15)] hover:bg-primary/20 hover:shadow-[0_0_10px_rgba(19,91,236,0.25)]',
              )}
              title={`${t('terminal.aiGenerator')} (⌘+I)`}
            >
              <Sparkles className={cn('h-3.5 w-3.5', !showAI && 'animate-pulse')} />
              AI
            </button>
          )}
          {onToggleRightSidebar && (
            <button
              type="button"
              onClick={onToggleRightSidebar}
              className={cn(
                'hidden items-center rounded-md px-1.5 py-1 transition-colors md:flex',
                rightSidebarOpen
                  ? 'text-primary hover:bg-primary/10'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              style={{ color: rightSidebarOpen ? undefined : `${fg}88` }}
              title={t('rightSidebar.terminal')}
            >
              {rightSidebarOpen
                ? <PanelRightClose className="h-4 w-4" />
                : <PanelRightOpen className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>
      {showSearch && (
        <TerminalSearchBar
          searchAddon={searchAddonRef.current}
          onClose={() => { setShowSearch(false); termRef.current?.focus() }}
        />
      )}
      {isConnected && (
        <AICommandBar
          visible={showAI}
          onExecuteCommand={handleExecuteCommand}
          getTerminalContext={getTerminalContext}
          onClose={() => setShowAI(false)}
        />
      )}
      <div
        ref={containerRef}
        className="min-h-0 flex-1"
        onClick={handleContainerClick}
      />
      <SuggestBar
        visible={showSuggestions && isConnected}
        inputLine={currentInputLine}
        historyEntries={[]}
        terminalContext={showSuggestions ? getTerminalContext() : ''}
        onAccept={(cmd) => {
          const remaining = cmd.slice(currentInputLine.length)
          if (remaining) onSendRawRef.current(remaining)
          inputLineRef.current = ''
          setCurrentInputLine('')
          setShowSuggestions(false)
        }}
        onDismiss={() => setShowSuggestions(false)}
      />
      {isDisconnected && !isReconnecting && onReconnect && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: `${bg}cc` }}>
          <div className="flex flex-col items-center gap-4 rounded-xl border border-red-500/20 bg-black/60 px-8 py-6 shadow-lg backdrop-blur-sm">
            <WifiOff className="h-8 w-8 text-red-400" />
            <p className="text-sm font-medium text-red-300">{t('terminal.connectionLost')}</p>
            <button
              type="button"
              onClick={onReconnect}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/80"
            >
              <RefreshCw className="h-4 w-4" />
              {t('terminal.reconnect')}
            </button>
          </div>
        </div>
      )}
      {isReconnecting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center" style={{ background: `${bg}99` }}>
          <div className="flex flex-col items-center gap-3 rounded-xl border border-amber-500/20 bg-black/60 px-8 py-6 shadow-lg backdrop-blur-sm">
            <RefreshCw className="h-7 w-7 animate-spin text-amber-400" />
            <p className="text-sm font-medium text-amber-300">{t('terminal.reconnecting')}</p>
          </div>
        </div>
      )}
      {isConnected && (
        <MobileTerminalToolbar onSend={onSendRaw} onToggleAI={() => setShowAI((v) => !v)} showAI={showAI} />
      )}
    </div>
  )
}
