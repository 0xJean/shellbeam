import { useSnippetVariableFill } from '@/hooks/use-snippet-variable-fill'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { getInteractiveHistory, isInteractiveHistoryEvent, subscribeInteractiveHistory } from '@/lib/interactive-history'
import { fill } from '@/lib/locales/probe-install'
import { mobileTerminalV3Copy } from '@/lib/locales/mobile-terminal-v3'
import type { SnippetEntry } from '@/lib/snippets'
import { TERMINAL_THEMES, type TerminalPrefs } from '@/lib/terminal-themes'
import { cn } from '@/lib/utils'
import { ClipboardPaste, CodeXml, Copy, History, Minus, Palette, Play, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type DrawerTab = 'snippets' | 'history' | 'appearance'

const HISTORY_LIMIT = 200
const FONT_MIN = 10
const FONT_MAX = 24

interface MobileTerminalDrawerProps {
  visible: boolean
  onClose: () => void
  hostAddress: string
  snippets: SnippetEntry[]
  onApplySnippet: (command: string) => void
  onRunSnippet: (command: string) => void
  terminalPrefs: TerminalPrefs
  onTerminalPrefsChange: (prefs: Partial<TerminalPrefs>) => void
  onSearchToggle?: () => void
  searchVisible?: boolean
  hosts?: HostProfile[]
  vaultId?: string
}

const rowButton = 'flex h-11 w-11 shrink-0 items-center justify-center'
const rowIcon = 'flex h-8 w-8 items-center justify-center rounded-full'

export function MobileTerminalDrawer({
  visible, onClose, hostAddress, snippets, onApplySnippet, onRunSnippet, terminalPrefs, onTerminalPrefsChange, onSearchToggle, searchVisible, hosts, vaultId,
}: MobileTerminalDrawerProps) {
  const { locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const [tab, setTab] = useState<DrawerTab>('snippets')
  if (!visible) return null
  const hostName = hosts?.find((host) => host.address === hostAddress)?.name || hostAddress
  const tabs: { id: DrawerTab; label: string; Icon: typeof CodeXml }[] = [
    { id: 'snippets', label: copy.snippets, Icon: CodeXml },
    { id: 'history', label: copy.history, Icon: History },
    { id: 'appearance', label: copy.appearance, Icon: Palette },
  ]

  return createPortal(
    <div className="fixed inset-0 z-50 md:hidden" data-testid="mobile-terminal-drawer">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <aside role="dialog" aria-modal="true" aria-label={copy.more}
        className="absolute inset-y-0 right-0 flex w-[85vw] max-w-sm flex-col rounded-l-[20px] bg-[var(--workspace-surface-950)] shadow-[var(--workspace-shadow-overlay)]"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="flex shrink-0 items-center gap-1 px-3 pb-2">
          <div role="tablist" className="flex min-w-0 flex-1 rounded-xl bg-[var(--workspace-surface-800)] p-0.5">
            {tabs.map(({ id, label, Icon }) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                className={cn('flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] text-[13px] transition-colors',
                  tab === id ? 'bg-[var(--workspace-surface-700)] font-semibold text-[var(--workspace-text-strong)] shadow-sm' : 'text-[var(--workspace-text-muted)]')}>
                <Icon className="h-3.5 w-3.5 shrink-0" />{label}
              </button>
            ))}
          </div>
          {onSearchToggle && (
            <button type="button" aria-label={copy.searchTerminal} aria-pressed={!!searchVisible} onClick={() => { onSearchToggle(); onClose() }}
              className={cn(rowButton, 'rounded-full', searchVisible ? 'text-[var(--workspace-accent-text)]' : 'text-[var(--workspace-text-muted)]')}>
              <Search className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
          {tab === 'snippets' && <SnippetsTab snippets={snippets} onApply={onApplySnippet} onRun={onRunSnippet} />}
          {tab === 'history' && <HistoryTab vaultId={vaultId} hostAddress={hostAddress} hostName={hostName} onRun={onRunSnippet} />}
          {tab === 'appearance' && <AppearanceTab prefs={terminalPrefs} onChange={onTerminalPrefsChange} />}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function SnippetsTab({ snippets, onApply, onRun }: { snippets: SnippetEntry[]; onApply: (command: string) => void; onRun: (command: string) => void }) {
  const { locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const [query, setQuery] = useState('')
  const variableFill = useSnippetVariableFill()
  const q = query.trim().toLowerCase()
  const filtered = q ? snippets.filter((snippet) => snippet.name.toLowerCase().includes(q) || snippet.command.toLowerCase().includes(q)) : snippets
  return (
    <div>
      {variableFill.dialog}
      <label className="mb-2 flex h-11 items-center gap-2 rounded-xl bg-[var(--workspace-surface-800)] px-3">
        <Search className="h-4 w-4 shrink-0 text-[var(--workspace-text-subtle)]" />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchSnippets}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)]" />
      </label>
      {filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-[var(--workspace-text-muted)]">{snippets.length === 0 ? copy.noSnippets : copy.noMatches}</p>
      ) : (
        <ul>
          {filtered.map((snippet) => (
            <li key={snippet.id} className="flex items-center border-b border-[color:var(--workspace-border-soft)]">
              <span className="min-w-0 flex-1 truncate py-3 text-[15px] text-[var(--workspace-text-strong)]" title={snippet.command}>{snippet.name}</span>
              <button type="button" aria-label={`${copy.paste} ${snippet.name}`} onClick={() => variableFill.request(snippet.command, onApply, snippet.name)} className={rowButton}>
                <span className={cn(rowIcon, 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}><ClipboardPaste className="h-4 w-4" /></span>
              </button>
              <button type="button" aria-label={`${copy.run} ${snippet.name}`} onClick={() => variableFill.request(snippet.command, onRun, snippet.name)} className={rowButton}>
                <span className={cn(rowIcon, 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]')}><Play className="h-4 w-4" /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-[var(--workspace-text-subtle)]">{copy.pasteHint}</p>
    </div>
  )
}

function HistoryTab({ vaultId, hostAddress, hostName, onRun }: { vaultId?: string; hostAddress: string; hostName: string; onRun: (command: string) => void }) {
  const { locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const [, setVersion] = useState(0)
  useEffect(() => subscribeInteractiveHistory((vault, host) => { if (isInteractiveHistoryEvent(vaultId, hostAddress, vault, host)) setVersion((value) => value + 1) }), [vaultId, hostAddress])
  const commands = getInteractiveHistory(vaultId, hostAddress).slice().reverse()
  return (
    <div>
      <p className="mb-1.5 text-xs text-[var(--workspace-text-subtle)]">{fill(copy.historyMeta, { host: hostName, count: HISTORY_LIMIT })}</p>
      {commands.length === 0 ? (
        <p className="py-10 text-center text-sm text-[var(--workspace-text-muted)]">{copy.noHistory}</p>
      ) : (
        <ul>
          {commands.map((entry, index) => (
            <li key={`${entry.timestamp}-${index}`} className="flex items-center gap-2 border-b border-[color:var(--workspace-border-soft)]">
              <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--workspace-text-subtle)]">
                {new Date(entry.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })}
              </span>
              <code className="min-w-0 flex-1 truncate py-3 font-mono text-[13px] text-[var(--workspace-text-strong)]" title={entry.command}>{entry.command}</code>
              <button type="button" aria-label={`${copy.copy} ${entry.command}`} onClick={() => { void navigator.clipboard?.writeText(entry.command).catch(() => {}) }} className={rowButton}>
                <span className={cn(rowIcon, 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}><Copy className="h-4 w-4" /></span>
              </button>
              <button type="button" aria-label={`${copy.run} ${entry.command}`} onClick={() => onRun(entry.command)} className={rowButton}>
                <span className={cn(rowIcon, 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]')}><Play className="h-4 w-4" /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AppearanceTab({ prefs, onChange }: { prefs: TerminalPrefs; onChange: (prefs: Partial<TerminalPrefs>) => void }) {
  const { locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const size = prefs.fontSize ?? 13
  return (
    <div>
      <h3 className="mb-2 text-xs text-[var(--workspace-text-subtle)]">{copy.fontSize}</h3>
      <div className="flex h-11 items-center rounded-xl bg-[var(--workspace-surface-800)]">
        <button type="button" aria-label={copy.decrease} disabled={size <= FONT_MIN} onClick={() => onChange({ fontSize: Math.max(FONT_MIN, size - 1) })}
          className="flex h-11 w-12 items-center justify-center text-[var(--workspace-text)] disabled:opacity-40"><Minus className="h-4 w-4" /></button>
        <output className="flex-1 text-center text-[17px] font-semibold tabular-nums text-[var(--workspace-text-strong)]">{size}</output>
        <button type="button" aria-label={copy.increase} disabled={size >= FONT_MAX} onClick={() => onChange({ fontSize: Math.min(FONT_MAX, size + 1) })}
          className="flex h-11 w-12 items-center justify-center text-[var(--workspace-text)] disabled:opacity-40"><Plus className="h-4 w-4" /></button>
      </div>
      <h3 className="mb-2 mt-5 text-xs text-[var(--workspace-text-subtle)]">{copy.colorScheme}</h3>
      <div className="grid grid-cols-3 gap-2.5">
        {TERMINAL_THEMES.map((theme) => {
          const selected = prefs.themeId === theme.id
          return (
            <button key={theme.id} type="button" aria-pressed={selected} onClick={() => onChange({ themeId: theme.id })}
              className="flex min-w-0 flex-col items-center gap-1 text-[11px] text-[var(--workspace-text-muted)] aria-pressed:font-semibold aria-pressed:text-[var(--workspace-text-strong)]">
              <span aria-hidden="true"
                className={cn('flex h-12 w-full items-center justify-center rounded-xl border font-mono text-xs font-semibold',
                  selected ? 'border-[color:var(--workspace-primary-500)] ring-2 ring-[color:var(--workspace-primary-500)]' : 'border-[color:var(--workspace-border-soft)]')}
                style={{ background: theme.theme.background, color: theme.theme.green ?? theme.theme.foreground }}>Aa</span>
              <span className="max-w-full truncate">{theme.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
