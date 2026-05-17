import { SnippetCompactList } from '@/components/snippet-compact-list'
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
import { Clock, Code2, Copy, Palette, Play, Rocket, Search } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

type TabId = 'terminal' | 'snippets' | 'history' | 'appearance'

const TABS: { id: TabId; Icon: typeof Rocket }[] = [
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
}: TerminalRightSidebarProps) {
  const { t } = useT()
  const [activeTab, setActiveTab] = useState<TabId>('terminal')

  if (!visible) return null

  const tabBar = (
    <div className="flex shrink-0 items-center border-b border-border/50">
      {TABS.map(({ id, Icon }) => (
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
