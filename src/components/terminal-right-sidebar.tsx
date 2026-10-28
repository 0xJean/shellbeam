import { SnippetCompactList } from '@/components/snippet-compact-list'
import { useSnippetVariableFill } from '@/hooks/use-snippet-variable-fill'
import { FontSizeControl, TerminalThemeGrid } from '@/components/terminal-widgets'
import { useT } from '@/lib/i18n'
import {
    getInteractiveHistory,
    subscribeInteractiveHistory,
    type InteractiveCommand,
} from '@/lib/interactive-history'
import type { SnippetEntry } from '@/lib/snippets'
import type { TerminalPrefs } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import { Activity, ArrowUpRight, Clock, Code2, Copy, Palette, Play, Rocket, Search } from 'lucide-react'
import { Sparkline } from '@/components/charts/chart-primitives'
import { useHostMetricHistory } from '@/hooks/use-host-metric-history'
import type { HostProfile } from '@/lib/hosts'
import { terminalSidebarCopy } from '@/lib/locales/terminal-sidebar'
import { formatBytes, formatBytesRate } from '@/lib/metric-series'
import { resolveWorkspaceMetricsHost } from '@/lib/workspace-metrics'
import { useWorkspaceProviderState } from '@/lib/workspace-provider-state'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { HistoryEntryRow } from '@/components/history-panel'
import { useCommandHistory } from '@/hooks/use-command-history'

type TabId = 'status' | 'terminal' | 'snippets' | 'history' | 'appearance'

const TABS: { id: TabId; Icon: typeof Rocket }[] = [
  { id: 'status', Icon: Activity },
  { id: 'terminal', Icon: Rocket },
  { id: 'snippets', Icon: Code2 },
  { id: 'history', Icon: Clock },
  { id: 'appearance', Icon: Palette },
]

interface TerminalRightSidebarProps {
  visible: boolean
  onClose: () => void
  hostAddress: string
  snippets: SnippetEntry[]
  onApplySnippet: (command: string) => void
  onRunSnippet: (command: string) => void
  terminalPrefs: TerminalPrefs
  onTerminalPrefsChange: (prefs: Partial<TerminalPrefs>) => void
  onSearchToggle: () => void
  searchVisible: boolean
  /** With hosts known, the sidebar opens on the host's live status (v3). */
  hosts?: HostProfile[]
  vaultId?: string
}

export function TerminalRightSidebar({
  visible,
  onClose,
  hostAddress,
  snippets,
  onApplySnippet,
  onRunSnippet,
  terminalPrefs,
  onTerminalPrefsChange,
  onSearchToggle,
  searchVisible,
  hosts,
  vaultId,
}: TerminalRightSidebarProps) {
  const { t } = useT()
  const [activeTab, setActiveTab] = useState<TabId>(hosts ? 'status' : 'terminal')
  const tabs = hosts ? TABS : TABS.filter((tab) => tab.id !== 'status')

  if (!visible) return null

  const tabBar = (
    <div className="flex shrink-0 items-center border-b border-border/50">
      {tabs.map(({ id, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => setActiveTab(id)}
          className={cn(
            'flex flex-1 items-center justify-center py-2.5 transition-colors',
            activeTab === id
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
          title={t(`rightSidebar.${id}`)}
        >
          <Icon className={cn('h-4 w-4', activeTab === id && 'drop-shadow-sm')} />
        </button>
      ))}
    </div>
  )

  const content = (
    <div className="min-h-0 flex-1 overflow-auto">
      {activeTab === 'status' && hosts && (
        <StatusTab hosts={hosts} vaultId={vaultId} hostAddress={hostAddress} snippets={snippets} onRunSnippet={onRunSnippet} onShowSnippets={() => setActiveTab('snippets')} />
      )}
      {activeTab === 'terminal' && (
        <TerminalTab onSearchToggle={onSearchToggle} searchVisible={searchVisible} />
      )}
      {activeTab === 'snippets' && (
        <SnippetCompactList snippets={snippets} onApply={onApplySnippet} onRun={onRunSnippet} />
      )}
      {activeTab === 'history' && <HistoryTab hostAddress={hostAddress} onRunCommand={onRunSnippet} />}
      {activeTab === 'appearance' && (
        <AppearanceTab terminalPrefs={terminalPrefs} onChange={onTerminalPrefsChange} />
      )}
    </div>
  )

  return (
    <>
      {/* Mobile: overlay backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={onClose} />
      {/* Mobile: slide-over drawer */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-[85vw] max-w-sm flex-col border-l border-border/50 bg-background pt-[env(safe-area-inset-top)] shadow-xl md:hidden">
        {tabBar}
        {content}
      </div>
      {/* PC: inline sidebar */}
      <div className="hidden h-full w-72 shrink-0 flex-col border-l border-border/50 bg-background md:flex 2xl:w-80">
        {tabBar}
        {content}
      </div>
    </>
  )
}

function StatusTab({ hosts, vaultId, hostAddress, snippets, onRunSnippet, onShowSnippets }: {
  hosts: HostProfile[]; vaultId?: string; hostAddress: string; snippets: SnippetEntry[]; onRunSnippet: (command: string) => void; onShowSnippets: () => void
}) {
  const { t, locale } = useT()
  const c = terminalSidebarCopy[locale]
  const variableFill = useSnippetVariableFill()
  const host = resolveWorkspaceMetricsHost(hosts, { hostAddress, vaultId }) ?? null
  const provider = useWorkspaceProviderState({ host, hosts, vaultId })
  const snapshot = provider.view?.metrics ?? null
  const history = useHostMetricHistory(host?.vaultId ?? vaultId, host?.id, 1)
  const rows: Array<{ key: string; label: string; value: string; values: Array<number | null> }> = [
    { key: 'cpu', label: 'CPU', value: snapshot?.cpuPercent == null ? '—' : `${Math.round(snapshot.cpuPercent)}%`, values: history.map((point) => point.metrics.cpuPercent) },
    { key: 'memory', label: c.memory, value: snapshot?.memoryPercent == null ? '—' : `${Math.round(snapshot.memoryPercent)}%`, values: history.map((point) => point.metrics.memoryPercent) },
    { key: 'disk', label: c.disk, value: snapshot?.diskPercent == null ? '—' : `${Math.round(snapshot.diskPercent)}%`, values: history.map((point) => point.metrics.diskPercent) },
    { key: 'network', label: `${c.network} ↓`, value: formatBytesRate(snapshot?.networkRxBytesPerSec), values: history.map((point) => point.metrics.networkRxBytesPerSec) },
  ]
  const uptime = snapshot?.uptimeSeconds == null ? null : `${Math.floor(snapshot.uptimeSeconds / 86400)} ${c.days} ${Math.floor((snapshot.uptimeSeconds % 86400) / 3600)} ${c.hours}`
  const info: Array<[string, string | null | undefined]> = [
    [c.kernel, snapshot?.kernel], [c.os, snapshot?.os], [c.memory, snapshot?.memoryTotalBytes ? formatBytes(snapshot.memoryTotalBytes) : null], [c.uptime, uptime],
    [c.load, snapshot?.load1 == null ? null : [snapshot.load1, snapshot.load5, snapshot.load15].map((value) => value == null ? '—' : value.toFixed(2)).join(' ')],
  ]
  return (
    <div data-testid="terminal-sidebar-status" className="space-y-5 p-4">
      {variableFill.dialog}
      <section>
        <div className="mb-2 flex items-center justify-between text-xs"><h3 className="font-semibold text-foreground">{c.live}</h3>
          {snapshot?.sampledAt ? <span className="text-[11px] text-muted-foreground">{new Date(snapshot.sampledAt).toLocaleTimeString(locale)}</span> : null}</div>
        {!host ? <p className="text-xs text-muted-foreground">{c.noHost}</p> : !snapshot ? <p className="text-xs text-muted-foreground">{c.noSample}</p> : (
          <div className="divide-y divide-border/50">
            {rows.map((row) => <div key={row.key} className="flex items-end justify-between gap-3 py-2.5">
              <div><div className="text-[11px] text-muted-foreground">{row.label}</div><div className="font-mono text-sm font-semibold text-foreground">{row.value}</div></div>
              {row.values.filter((value) => value != null).length > 1 && <Sparkline values={row.values} width={116} height={28} />}
            </div>)}
          </div>
        )}
      </section>
      {snapshot && <section>
        <h3 className="mb-2 text-xs font-semibold text-foreground">{c.system}</h3>
        <dl className="space-y-1.5 text-xs">
          {info.filter(([, value]) => value).map(([label, value]) => <div key={label} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="truncate font-mono text-foreground" title={value ?? undefined}>{value}</dd></div>)}
        </dl>
      </section>}
      {snippets.length > 0 && <section>
        <div className="mb-2 flex items-center justify-between text-xs"><h3 className="font-semibold text-foreground">{c.snippets}</h3>
          <button type="button" onClick={onShowSnippets} className="text-muted-foreground hover:text-foreground" aria-label={t('rightSidebar.snippets')}><ArrowUpRight className="h-3.5 w-3.5" /></button></div>
        <ul className="space-y-1">
          {snippets.slice(0, 4).map((snippet) => <li key={snippet.id}>
            <button type="button" onClick={() => variableFill.request(snippet.command, onRunSnippet, snippet.name)} title={snippet.command} className="flex w-full items-center gap-2 rounded-md border border-border/50 px-2.5 py-2 text-left text-xs hover:bg-muted/50">
              <Code2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{snippet.name}</span><Play className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
          </li>)}
        </ul>
      </section>}
    </div>
  )
}

function TerminalTab({ onSearchToggle, searchVisible }: {
  onSearchToggle: () => void
  searchVisible: boolean
}) {
  const { t } = useT()
  return (
    <div className="space-y-1 p-3">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('rightSidebar.terminalFeatures')}
      </h3>
      <button
        type="button"
        onClick={onSearchToggle}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
          searchVisible ? 'bg-primary/10 text-primary' : 'hover:bg-muted/50',
        )}
      >
        <Search className="h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t('rightSidebar.searchTerminal')}</p>
          <p className="text-[11px] text-muted-foreground">⌘+Shift+F</p>
        </div>
      </button>
      <div className="mt-4 rounded-lg border border-border/50 p-3">
        <p className="text-xs font-medium">{t('rightSidebar.shortcuts')}</p>
        <div className="mt-2 space-y-1.5">
          {[
            { keys: '⌘+I', desc: t('rightSidebar.aiAssist') },
            { keys: '⌘+⇧+F', desc: t('rightSidebar.search') },
            { keys: 'Ctrl+Space', desc: t('rightSidebar.autocomplete') },
            { keys: 'Ctrl+C', desc: t('rightSidebar.interrupt') },
            { keys: 'Ctrl+D', desc: t('rightSidebar.eof') },
            { keys: 'Ctrl+L', desc: t('rightSidebar.clear') },
          ].map((s) => (
            <div key={s.keys} className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">{s.desc}</span>
              <kbd className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px]">{s.keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function HistoryTab({ hostAddress, onRunCommand }: {
  hostAddress: string
  onRunCommand: (cmd: string) => void
}) {
  const { t } = useT()
  const [view, setView] = useState<'typed' | 'runs'>('typed')
  return (
    <div className="flex min-h-0 flex-col">
      <div role="radiogroup" aria-label={t('history.title')} className="m-2 inline-flex w-fit gap-0.5 rounded-md bg-muted/60 p-0.5">
        {(['typed', 'runs'] as const).map((key) => (
          <button key={key} type="button" role="radio" aria-checked={view === key} data-testid={`history-view-${key}`} onClick={() => setView(key)}
            className={cn('h-6 rounded px-2.5 text-[11px] font-medium', view === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
            {t(key === 'typed' ? 'rightSidebar.historyTyped' : 'rightSidebar.historyRuns')}
          </button>
        ))}
      </div>
      {view === 'typed' ? <TypedHistory hostAddress={hostAddress} onRunCommand={onRunCommand} /> : <RunHistory hostAddress={hostAddress} />}
    </div>
  )
}

/** Commands run through ShellBeam's command mode, with status and output. */
function RunHistory({ hostAddress }: { hostAddress: string }) {
  const { t } = useT()
  const filter = useMemo(() => (hostAddress ? { host: hostAddress } : undefined), [hostAddress])
  const { entries, loading } = useCommandHistory(filter)
  if (loading) return <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t('history.loading')}</p>
  if (entries.length === 0) return <p className="px-3 py-12 text-center text-xs text-muted-foreground">{t('history.empty')}</p>
  return <div className="min-h-0 overflow-auto">{entries.map((entry) => <HistoryEntryRow key={entry.id} entry={entry} compact />)}</div>
}

function TypedHistory({ hostAddress, onRunCommand }: {
  hostAddress: string
  onRunCommand: (cmd: string) => void
}) {
  const { t } = useT()
  const [commands, setCommands] = useState<InteractiveCommand[]>([])

  const refresh = useCallback(() => {
    setCommands(getInteractiveHistory(hostAddress).slice().reverse())
  }, [hostAddress])

  useEffect(() => {
    refresh()
    return subscribeInteractiveHistory((host) => {
      if (host === hostAddress) refresh()
    })
  }, [refresh, hostAddress])

  if (commands.length === 0) {
    return (
      <div className="px-3 py-12 text-center">
        <Clock className="mx-auto h-8 w-8 text-muted-foreground/30" />
        <p className="mt-2 text-xs text-muted-foreground">{t('history.empty')}</p>
      </div>
    )
  }

  return (
    <div className="min-h-0 overflow-auto">
      {commands.map((cmd, i) => (
        <div
          key={`${cmd.timestamp}-${i}`}
          className="group flex items-center gap-2 border-b border-border/30 px-3 py-2 transition-colors hover:bg-muted/30"
        >
          <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{cmd.command}</code>
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              onClick={() => { void navigator.clipboard.writeText(cmd.command) }}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('common.copy') ?? 'Copy'}
            >
              <Copy className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => onRunCommand(cmd.command)}
              className="rounded p-1 text-muted-foreground hover:bg-primary/20 hover:text-primary"
              title={t('rightSidebar.runSnippet')}
            >
              <Play className="h-3 w-3" />
            </button>
          </div>
          <span className="shrink-0 text-[9px] text-muted-foreground/50">
            {new Date(cmd.timestamp).toLocaleTimeString()}
          </span>
        </div>
      ))}
    </div>
  )
}

function AppearanceTab({ terminalPrefs, onChange }: {
  terminalPrefs: TerminalPrefs
  onChange: (prefs: Partial<TerminalPrefs>) => void
}) {
  const { t } = useT()
  return (
    <div className="space-y-4 p-3">
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('settings.fontSize')}
        </h3>
        <FontSizeControl
          value={terminalPrefs.fontSize ?? 13}
          onChange={(size) => onChange({ fontSize: size })}
        />
      </div>
      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('settings.colorTheme')}
        </h3>
        <TerminalThemeGrid
          currentThemeId={terminalPrefs.themeId}
          onSelect={(id) => onChange({ themeId: id })}
        />
      </div>
    </div>
  )
}
