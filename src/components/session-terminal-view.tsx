import { getInteractiveHistory, isInteractiveHistoryEvent, subscribeInteractiveHistory } from '@/lib/interactive-history'
import { announceTerminalAiState, announceTerminalSearchState, requestTerminalSidebarTab, TERMINAL_AI_TOGGLE_EVENT, TERMINAL_SEARCH_TOGGLE_EVENT } from '@/lib/terminal-events'
import { normalizeBrowserUrl } from '@/contexts/session-browser-state'
import type { HostNetworkDisplay } from '@/hooks/use-host-network-metadata'
import { useVault } from '@/contexts/vault-context'
import { useT } from '@/lib/i18n'
import { recordInteractiveCommand } from '@/lib/interactive-history'
import type { InteractiveOutputChunk, InteractiveSessionInfo } from '@/lib/interactive-session'
import type { SessionWorkspaceMode } from '@/lib/workspace'
import { resizeInteractiveTerminal } from '@/lib/interactive-session'
import { DEFAULT_TERMINAL_PREFS, useResolvedTerminalTheme, type TerminalPrefs } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import { OUTPUT_LINE_LIMIT, type TerminalAiBridge } from '@/lib/ai-conversation'
import type { WorkspaceInventory, WorkspaceInventoryResource } from '@/lib/workspace-inventory'
import { collectHostFacts } from '@/lib/ai-host-facts'
import type { HostProfile } from '@/lib/hosts'
import { offersProbeInstall } from '@/lib/probe-install'
import { useProbeInstallReadiness } from '@/hooks/use-probe-install-readiness'
import { ProbeInstallDialog } from './probe-install-dialog'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Eraser, PanelRightClose, PanelRightOpen, ExternalLink, Globe, Palette, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { AICommandBar } from './ai-command-bar'
import { MobileTerminalToolbar } from './mobile-terminal-toolbar'
import { SuggestBar } from './suggest-bar'
import { SessionConnectionLostOverlay } from './session-connection-lost-overlay'
import { TerminalSearchBar } from './terminal-search-bar'
import { HostMetadataLine } from './host-display-meta'
import { WorkspaceModeToggle } from './workspace/workspace-mode-toggle'

const TERMINAL_SCROLLBACK_ROWS = 10000
const TERMINAL_WRITE_BACKLOG_LIMIT_CHARS = 1 << 20

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
  initialChunks?: InteractiveOutputChunk[]
  onInitialChunksConsumed?: (sessionId: string) => void
  workspaceMode?: SessionWorkspaceMode
  onWorkspaceModeChange?: (mode: SessionWorkspaceMode) => void
  chromeOnly?: boolean
  onOpenLinkInBrowser?: (url: string) => void
  onOpenBrowser?: () => void
  network?: HostNetworkDisplay
  resource?: Pick<WorkspaceInventoryResource, 'os'> & Partial<WorkspaceInventoryResource>
  /** The host's last asset scan, summarised for the AI assistant. */
  inventory?: WorkspaceInventory
  /** The saved host behind this session, used to offer the ShellBeam probe. */
  host?: HostProfile
}

// The readiness hook needs a host; with none it stays disabled and never reads this.
const NO_HOST = { id: '', updatedAt: 0 } as unknown as HostProfile

const STYLE_TIP_KEY = 'shellbeam.terminalStyleTipSeen'
const STYLE_TIP_SEEN_EVENT = 'shellbeam:terminal-style-tip-seen'

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
  initialChunks,
  onInitialChunksConsumed,
  workspaceMode = 'terminal',
  onWorkspaceModeChange,
  chromeOnly = false,
  onOpenLinkInBrowser,
  onOpenBrowser,
  network,
  resource,
  inventory,
  host,
}: SessionTerminalViewProps) {
  const { t } = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const onSendRawRef = useRef(onSendRaw)
  const [showAI, setShowAI] = useState(false)
  const { readiness: probeReadiness } = useProbeInstallReadiness(host ?? NO_HOST, Boolean(host?.vaultId) && showAI)
  const probeOffered = Boolean(host && probeReadiness && offersProbeInstall(probeReadiness, inventory?.resource.os ?? resource?.os))
  const [probeDialogOpen, setProbeDialogOpen] = useState(false)
  const terminalTheme = useResolvedTerminalTheme(terminalPrefs?.themeId)
  const [showSearch, setShowSearch] = useState(false)
  const [styleTip, setStyleTip] = useState(() => { try { return !localStorage.getItem(STYLE_TIP_KEY) } catch { return false } })
  useEffect(() => {
    const hide = () => setStyleTip(false)
    window.addEventListener(STYLE_TIP_SEEN_EVENT, hide)
    return () => window.removeEventListener(STYLE_TIP_SEEN_EVENT, hide)
  }, [])
  const dismissStyleTip = useCallback(() => {
    try { localStorage.setItem(STYLE_TIP_KEY, '1') } catch { /* tip shows again next time */ }
    window.dispatchEvent(new Event(STYLE_TIP_SEEN_EVENT))
  }, [])
  // Commands typed on this host feed the history half of the suggestion bar.
  // Typed history is per vault: the session's own vault, else the active one.
  const { activeVaultId } = useVault()
  const historyVaultId = session?.vaultId ?? activeVaultId
  const historyVaultIdRef = useRef(historyVaultId)
  useEffect(() => { historyVaultIdRef.current = historyVaultId }, [historyVaultId])
  const [historyEntries, setHistoryEntries] = useState<string[]>(() => getInteractiveHistory(historyVaultId, hostAddress).map((entry) => entry.command).reverse())
  useEffect(() => {
    const load = () => setHistoryEntries(getInteractiveHistory(historyVaultId, hostAddress).map((entry) => entry.command).reverse())
    load()
    return subscribeInteractiveHistory((vault, host) => { if (isInteractiveHistoryEvent(historyVaultId, hostAddress, vault, host)) load() })
  }, [historyVaultId, hostAddress])
  useEffect(() => {
    const onToggle = (event: Event) => { if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) setShowSearch((open) => !open) }
    window.addEventListener(TERMINAL_SEARCH_TOGGLE_EVENT, onToggle)
    return () => window.removeEventListener(TERMINAL_SEARCH_TOGGLE_EVENT, onToggle)
  }, [sessionId])
  useEffect(() => { announceTerminalSearchState(sessionId, showSearch) }, [sessionId, showSearch])
  useEffect(() => {
    const onToggle = (event: Event) => { if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) setShowAI((open) => !open) }
    window.addEventListener(TERMINAL_AI_TOGGLE_EVENT, onToggle)
    return () => window.removeEventListener(TERMINAL_AI_TOGGLE_EVENT, onToggle)
  }, [sessionId])
  useEffect(() => { announceTerminalAiState(sessionId, showAI) }, [sessionId, showAI])
  // The assistant works on the terminal, so asking for it from the workbench switches to the terminal.
  useEffect(() => {
    if (showAI && chromeOnly && workspaceMode !== 'terminal') onWorkspaceModeChange?.('terminal')
  }, [showAI, chromeOnly, workspaceMode, onWorkspaceModeChange])
  const [currentInputLine, setCurrentInputLine] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [detectedLinks, setDetectedLinks] = useState<string[]>([])
  const [showLinkMenu, setShowLinkMenu] = useState(false)
  const [entered, setEntered] = useState(false)
  const inputLineRef = useRef('')
  const showSuggestionsRef = useRef(false)
  const uiSyncFrameRef = useRef<number | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)

  onSendRawRef.current = onSendRaw

  const isConnected = session?.status?.startsWith('running') ?? false
  const isDisconnected = session?.status?.startsWith('closed') ?? false
  const outputThrottledText = t('terminal.outputThrottled')

  const prefsRef = useRef(terminalPrefs)
  prefsRef.current = terminalPrefs

  const getTerminalContext = useCallback((rows = 20) => {
    const term = termRef.current
    if (!term) return ''
    const buf = term.buffer.active
    const totalRows = buf.length
    const startRow = Math.max(0, totalRows - rows)
    const lines: string[] = []
    for (let i = startRow; i < totalRows; i++) {
      const line = buf.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    return lines.join('\n').trim()
  }, [])

  const detectLinks = useCallback((text: string) => {
    const httpMatches = text.match(/https?:\/\/[^\s)\]}>"']+/g) ?? []
    const bareMatches = Array.from(
      text.matchAll(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|(?:\d{1,3}\.){3}\d{1,3}|[a-zA-Z0-9.-]+):\d{2,5}(?:\/[^\s)\]}>"']*)?/g),
      (match) => normalizeBrowserUrl(match[0]),
    ).filter(Boolean)
    setDetectedLinks((prev) => Array.from(new Set([...prev, ...httpMatches, ...bareMatches])).slice(-5))
  }, [])

  const handleExecuteCommand = useCallback((cmd: string) => {
    onSendRawRef.current(cmd)
  }, [])

  const hostFacts = useMemo(() => collectHostFacts({
    name: hostName, user: session?.username, address: hostAddress,
    region: network?.countryName ?? network?.resolvedLocationLabel, resource, inventory,
  }), [hostName, session?.username, hostAddress, network?.countryName, network?.resolvedLocationLabel, resource, inventory])

  // The AI panel runs commands here and reads back what the terminal printed after them.
  const aiBridge = useMemo<TerminalAiBridge>(() => ({
    run(command) {
      const term = termRef.current
      const marker = term?.registerMarker(0)
      onSendRawRef.current(`${command.replace(/\n+$/, '').replace(/\n/g, '\r')}\r`)
      return {
        read() {
          if (!term) return ''
          const buf = term.buffer.active
          if (!marker || marker.isDisposed || marker.line < 0) return getTerminalContext(OUTPUT_LINE_LIMIT)
          const lines: string[] = []
          // The marker line is the prompt with the echoed command; output starts below it.
          for (let i = marker.line + 1; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
          return lines.join('\n')
        },
        onOutput(listener) {
          const subscription = term?.onWriteParsed(listener)
          return () => subscription?.dispose()
        },
        dispose: () => marker?.dispose(),
      }
    },
    insert: (command) => onSendRawRef.current(command.replace(/\n+$/, '').replace(/\n/g, '\r')),
    recentOutput: (rows) => getTerminalContext(rows),
    clear: () => termRef.current?.clear(),
  }), [getTerminalContext])

  const scheduleInputUiSync = useCallback(() => {
    if (uiSyncFrameRef.current !== null) return
    uiSyncFrameRef.current = window.requestAnimationFrame(() => {
      uiSyncFrameRef.current = null
      setCurrentInputLine(inputLineRef.current)
      setShowSuggestions(showSuggestionsRef.current)
    })
  }, [])

  useEffect(() => {
    setEntered(false)
    const frame = window.requestAnimationFrame(() => setEntered(true))
    return () => window.cancelAnimationFrame(frame)
  }, [sessionId])

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
        showSuggestionsRef.current = !showSuggestionsRef.current
        scheduleInputUiSync()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [scheduleInputUiSync])

  useEffect(() => {
    if (chromeOnly) return
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: terminalPrefs?.cursorBlink ?? DEFAULT_TERMINAL_PREFS.cursorBlink,
      cursorStyle: terminalPrefs?.cursorStyle ?? DEFAULT_TERMINAL_PREFS.cursorStyle,
      fontSize: terminalPrefs?.fontSize ?? DEFAULT_TERMINAL_PREFS.fontSize,
      fontFamily: terminalPrefs?.fontFamily ?? DEFAULT_TERMINAL_PREFS.fontFamily,
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      lineHeight: 1.2,
      minimumContrastRatio: 4.5,
      scrollback: TERMINAL_SCROLLBACK_ROWS,
      fastScrollSensitivity: 10,
      smoothScrollDuration: 0,
      rescaleOverlappingGlyphs: true,
      theme: terminalTheme,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    const search = new SearchAddon()
    term.loadAddon(search)
    searchAddonRef.current = search

    termRef.current = term
    fitRef.current = fit

    let pendingWriteChars = 0
    let droppedOutput = false

    const writeThrottleNoticeIfIdle = () => {
      if (pendingWriteChars !== 0 || !droppedOutput) return
      droppedOutput = false
      const notice = `\r\n\x1b[33m[ShellBeam] ${outputThrottledText}\x1b[0m\r\n`
      pendingWriteChars += notice.length
      term.write(notice, () => {
        pendingWriteChars = Math.max(0, pendingWriteChars - notice.length)
      })
    }

    chunkEmitterRef.current[sessionId] = (chunks) => {
      let batch = ''
      for (let i = 0; i < chunks.length; i++) batch += chunks[i].data

      if (pendingWriteChars + batch.length > TERMINAL_WRITE_BACKLOG_LIMIT_CHARS) {
        droppedOutput = true
        writeThrottleNoticeIfIdle()
        return
      }
      pendingWriteChars += batch.length
      detectLinks(batch)
      term.write(batch, () => {
        pendingWriteChars = Math.max(0, pendingWriteChars - batch.length)
        writeThrottleNoticeIfIdle()
      })
    }

    // Replay any chunks that were buffered before the emitter was registered
    if (initialChunks && initialChunks.length > 0) {
      let batch = ''
      for (let i = 0; i < initialChunks.length; i++) batch += initialChunks[i].data
      if (batch) {
        detectLinks(batch)
        pendingWriteChars += batch.length
        term.write(batch, () => {
          pendingWriteChars = Math.max(0, pendingWriteChars - batch.length)
          writeThrottleNoticeIfIdle()
        })
      }
      onInitialChunksConsumed?.(sessionId)
    }

    const onData = term.onData((data: string) => {
      onSendRawRef.current(data)
      if (data === '\r' || data === '\n') {
        if (inputLineRef.current.trim()) {
          recordInteractiveCommand(historyVaultIdRef.current, hostAddress, inputLineRef.current)
        }
        inputLineRef.current = ''
        showSuggestionsRef.current = false
        scheduleInputUiSync()
      } else if (data === '\x7f' || data === '\b') {
        inputLineRef.current = inputLineRef.current.slice(0, -1)
        showSuggestionsRef.current = inputLineRef.current.length >= 2
        scheduleInputUiSync()
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        inputLineRef.current += data
        showSuggestionsRef.current = inputLineRef.current.length >= 2
        scheduleInputUiSync()
      } else {
        inputLineRef.current = ''
        showSuggestionsRef.current = false
        scheduleInputUiSync()
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
      if (uiSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(uiSyncFrameRef.current)
        uiSyncFrameRef.current = null
      }
      searchAddonRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId, chunkEmitterRef, chromeOnly, outputThrottledText])

  useEffect(() => {
    if (chromeOnly) return
    const term = termRef.current
    if (!term || !terminalPrefs) return
    term.options.theme = terminalTheme
    term.options.fontSize = terminalPrefs.fontSize ?? DEFAULT_TERMINAL_PREFS.fontSize
    term.options.fontFamily = terminalPrefs.fontFamily ?? DEFAULT_TERMINAL_PREFS.fontFamily
    term.options.cursorStyle = terminalPrefs.cursorStyle ?? DEFAULT_TERMINAL_PREFS.cursorStyle
    term.options.cursorBlink = terminalPrefs.cursorBlink ?? DEFAULT_TERMINAL_PREFS.cursorBlink
    try { fitRef.current?.fit() } catch { /* teardown */ }
  }, [terminalTheme, terminalPrefs?.fontSize, terminalPrefs?.fontFamily, terminalPrefs?.cursorStyle, terminalPrefs?.cursorBlink, chromeOnly])

  const prevVisibleRef = useRef(visible)
  useEffect(() => {
    const wasHidden = !prevVisibleRef.current
    prevVisibleRef.current = visible
    if (!chromeOnly && visible && wasHidden) {
      requestAnimationFrame(() => {
        try { fitRef.current?.fit() } catch { /* teardown */ }
        termRef.current?.focus()
      })
    }
  }, [visible, chromeOnly])

  const handleContainerClick = useCallback(() => {
    termRef.current?.focus()
  }, [])

  const handleClearTerminalBuffer = useCallback(() => {
    termRef.current?.clear()
    termRef.current?.focus()
  }, [])

  const bg = terminalTheme.background ?? '#000000'
  const fg = terminalTheme.foreground ?? '#00ff41'
  const showBrowserShortcuts = !onWorkspaceModeChange

  return (
    <div
      data-testid="terminal-session" data-session-id={sessionId} data-host-name={hostName} data-host-id={session?.hostId} data-status={isConnected ? 'connected' : isDisconnected ? 'disconnected' : 'connecting'}
      className={cn('relative flex flex-col', chromeOnly ? 'shrink-0' : 'h-full')}
      style={{
        ...(chromeOnly ? {} : { background: bg }),
        opacity: entered ? 1 : 0,
        transition: 'opacity 160ms ease',
      }}
    >
      <div
        className="hidden h-9 shrink-0 items-center gap-2 overflow-hidden px-4 md:flex"
        style={{ borderBottom: `1px solid ${fg}15`, background: bg }}
      >
        <span className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          isConnected ? 'bg-emerald-500' : isReconnecting ? 'bg-amber-500 animate-pulse' : isDisconnected ? 'bg-red-500' : 'bg-gray-500',
        )} />
        <span className="min-w-0 truncate text-xs font-medium" style={{ color: `${fg}cc` }}>
          {session?.username ?? 'root'}@{hostAddress}
          {hostName && <span style={{ color: `${fg}66` }}> ({hostName})</span>}
          {isReconnecting && <span className="ml-2 text-amber-400">{t('terminal.reconnecting')}</span>}
        </span>
        <HostMetadataLine
          network={network}
          resource={resource}
          showLocationText={false}
          showSystemText={false}
          className="hidden flex-nowrap gap-x-1 sm:flex"
          iconClassName="h-3 w-3"
        />
        <div className="ml-auto flex items-center gap-1.5">
          {showBrowserShortcuts && onOpenBrowser && (
            <button
              type="button"
              onClick={onOpenBrowser}
              className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-semibold tracking-wide text-primary shadow-[0_0_6px_var(--workspace-accent-soft)] transition-all hover:bg-primary/20 hover:shadow-[0_0_10px_var(--workspace-accent-muted)] md:px-3"
              title={t('terminal.openBrowser')}
            >
              <Globe className="h-3.5 w-3.5" />
              <span className="hidden max-w-40 truncate md:inline">{t('terminal.browser')}</span>
            </button>
          )}
          {showBrowserShortcuts && detectedLinks.length > 0 && onOpenLinkInBrowser && (
            <div className="relative">
              <button
                type="button"
                onClick={() => onOpenLinkInBrowser(detectedLinks[detectedLinks.length - 1])}
                className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-semibold tracking-wide text-primary shadow-[0_0_6px_var(--workspace-accent-soft)] transition-all hover:bg-primary/20 hover:shadow-[0_0_10px_var(--workspace-accent-muted)] md:px-3"
                title={t('terminal.openLatestLink')}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span className="hidden max-w-40 truncate md:inline">{t('terminal.openLink')}</span>
              </button>
              {detectedLinks.length > 1 && (
                <button
                  type="button"
                  onClick={() => setShowLinkMenu((value) => !value)}
                  className="absolute -bottom-2 right-0 rounded-full border border-border/60 bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground shadow-sm"
                  title={t('terminal.showRecentLinks')}
                >
                  {detectedLinks.length}
                </button>
              )}
              {showLinkMenu && (
                <div className="absolute right-0 top-10 z-20 w-72 rounded-lg border border-border bg-popover p-1 shadow-xl">
                  {detectedLinks.slice().reverse().map((url) => (
                    <button
                      key={url}
                      type="button"
                      onClick={() => {
                        onOpenLinkInBrowser(url)
                        setShowLinkMenu(false)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-popover-foreground hover:bg-accent"
                      title={url}
                    >
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{url}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {onWorkspaceModeChange && (
            <div className="shrink-0">
              <WorkspaceModeToggle mode={workspaceMode} onChange={onWorkspaceModeChange} compact />
            </div>
          )}
          {!chromeOnly && (
            <button
              type="button"
              onClick={handleClearTerminalBuffer}
              className="flex items-center rounded-md px-1.5 py-1 text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
              title={t('terminal.clearScrollback')}
              aria-label={t('terminal.clearScrollback')}
            >
              <Eraser className="h-4 w-4" />
            </button>
          )}
          {onToggleRightSidebar && (
            <button
              type="button"
              onClick={onToggleRightSidebar}
              className={cn(
                'flex items-center rounded-md px-1.5 py-1 transition-colors',
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
      {!chromeOnly && showSearch && (
        <TerminalSearchBar
          searchAddon={searchAddonRef.current}
          onClose={() => { setShowSearch(false); termRef.current?.focus() }}
        />
      )}
      {!chromeOnly && (
        <>
          <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
          <div
            ref={containerRef}
            className="terminal-surface min-h-0 flex-1"
            onClick={handleContainerClick}
          />
          <SuggestBar
            key={sessionId}
            visible={showSuggestions && isConnected && visible}
            inputLine={currentInputLine}
            historyEntries={historyEntries}
            terminalContext={showSuggestions ? getTerminalContext() : ''}
            onAccept={(cmd) => {
              const remaining = cmd.slice(currentInputLine.length)
              if (remaining) onSendRawRef.current(remaining)
              inputLineRef.current = ''
              showSuggestionsRef.current = false
              scheduleInputUiSync()
            }}
            onDismiss={() => {
              showSuggestionsRef.current = false
              scheduleInputUiSync()
            }}
          />
          {styleTip && isConnected && visible && (
            <div role="status" data-testid="terminal-style-tip"
              className="absolute right-3 top-3 z-20 hidden w-72 rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-3 shadow-[var(--workspace-shadow-overlay)] md:block">
              <div className="flex items-start gap-2.5">
                <Palette className="mt-0.5 h-4 w-4 shrink-0 text-[var(--workspace-accent-text)]" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-[var(--workspace-text-strong)]">{t('terminal.styleTip.title')}</p>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--workspace-text-muted)]">{t('terminal.styleTip.body')}</p>
                  <div className="mt-2.5 flex gap-2">
                    <button type="button" onClick={() => { requestTerminalSidebarTab('appearance'); dismissStyleTip() }}
                      className="h-7 rounded-md bg-[var(--workspace-primary-500)] px-2.5 text-xs font-medium text-white hover:opacity-90">{t('terminal.styleTip.action')}</button>
                    <button type="button" onClick={dismissStyleTip}
                      className="h-7 rounded-md px-2.5 text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]">{t('terminal.styleTip.dismiss')}</button>
                  </div>
                </div>
                <button type="button" onClick={dismissStyleTip} aria-label={t('terminal.styleTip.dismiss')}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--workspace-text-subtle)] hover:bg-[var(--workspace-surface-800)] hover:text-[var(--workspace-text-strong)]">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
          <SessionConnectionLostOverlay sessionId={sessionId} hostName={hostName || hostAddress} backdrop={bg} isDisconnected={isDisconnected} isReconnecting={isReconnecting} onReconnect={onReconnect} />
          </div>
          {isConnected && (
            <AICommandBar
              key={sessionId}
              contextLabel={hostName || hostAddress}
              visible={showAI && visible}
              bridge={aiBridge}
              memoryKey={`${historyVaultId ?? 'none'}:${session?.username ?? ''}@${hostAddress}`}
              hostFacts={hostFacts}
              inventory={inventory}
              probe={probeOffered ? { onInstall: () => setProbeDialogOpen(true) } : undefined}
              onExecuteCommand={handleExecuteCommand}
              getTerminalContext={getTerminalContext}
              onClose={() => { setShowAI(false); termRef.current?.focus() }}
            />
          )}
          {host && probeDialogOpen && <ProbeInstallDialog host={host} open onOpenChange={setProbeDialogOpen} />}
          </div>

          {isConnected && (
            <MobileTerminalToolbar onSend={onSendRaw} />
          )}
        </>
      )}
    </div>
  )
}
