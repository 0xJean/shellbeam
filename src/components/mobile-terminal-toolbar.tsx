import { useT } from '@/lib/i18n'
import { mobileTerminalV3Copy } from '@/lib/locales/mobile-terminal-v3'
import { cn } from '@/lib/utils'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsLeftRight, X } from 'lucide-react'
import { useCallback, useRef, useState, type ReactNode } from 'react'

interface MobileTerminalToolbarProps {
  onSend: (data: string) => void
}

type Modifier = 'ctrl' | 'alt'
type ModState = 'off' | 'once' | 'locked'
type Panel = 'none' | 'fkeys' | 'ctrl' | 'symbols'

const SPECIAL_KEYS: { label: string; seq: string }[] = [
  { label: 'F1', seq: '\x1bOP' },
  { label: 'F2', seq: '\x1bOQ' },
  { label: 'F3', seq: '\x1bOR' },
  { label: 'F4', seq: '\x1bOS' },
  { label: 'F5', seq: '\x1b[15~' },
  { label: 'F6', seq: '\x1b[17~' },
  { label: 'F7', seq: '\x1b[18~' },
  { label: 'F8', seq: '\x1b[19~' },
  { label: 'F9', seq: '\x1b[20~' },
  { label: 'F10', seq: '\x1b[21~' },
  { label: 'F11', seq: '\x1b[23~' },
  { label: 'F12', seq: '\x1b[24~' },
]

const NAV_KEYS: { label: string; seq: string }[] = [
  { label: 'HOME', seq: '\x1b[H' },
  { label: 'END', seq: '\x1b[F' },
  { label: 'PGUP', seq: '\x1b[5~' },
  { label: 'PGDN', seq: '\x1b[6~' },
  { label: 'INS', seq: '\x1b[2~' },
  { label: 'DEL', seq: '\x1b[3~' },
]

const CTRL_SHORTCUTS = [
  { label: 'C', hint: 'Interrupt', code: '\x03' },
  { label: 'D', hint: 'EOF', code: '\x04' },
  { label: 'Z', hint: 'Suspend', code: '\x1a' },
  { label: 'L', hint: 'Clear', code: '\x0c' },
  { label: 'A', hint: 'Home', code: '\x01' },
  { label: 'E', hint: 'End', code: '\x05' },
  { label: 'R', hint: 'Search', code: '\x12' },
  { label: 'W', hint: 'Del word', code: '\x17' },
  { label: 'U', hint: 'Del line', code: '\x15' },
  { label: 'K', hint: 'Kill', code: '\x0b' },
  { label: 'P', hint: 'Prev', code: '\x10' },
  { label: 'N', hint: 'Next', code: '\x0e' },
]

const SYMBOL_KEYS = [
  '|', '/', '\\', '~', '-', '_', '.', '*',
  '$', '#', '@', '!', '&', ';', ':', '=',
  '+', '%', '^', '`', '"', "'", ',', '?',
  '<', '>', '(', ')', '[', ']', '{', '}',
]

function applyModifier(seq: string, mod: Set<Modifier>): string {
  if (mod.size === 0) return seq
  if (seq.length === 1) {
    const code = seq.charCodeAt(0)
    if (mod.has('ctrl') && code >= 0x61 && code <= 0x7a) return String.fromCharCode(code - 0x60)
    if (mod.has('ctrl') && code >= 0x41 && code <= 0x5a) return String.fromCharCode(code - 0x40)
    if (mod.has('alt')) return `\x1b${seq}`
  }
  return seq
}

export function MobileTerminalToolbar({ onSend }: MobileTerminalToolbarProps) {
  const { locale } = useT()
  const copy = mobileTerminalV3Copy[locale]
  const [activeModifiers, setActiveModifiers] = useState<Set<Modifier>>(new Set())
  const [lockedModifiers, setLockedModifiers] = useState<Set<Modifier>>(new Set())
  const [panel, setPanel] = useState<Panel>('none')
  const lastModTap = useRef<Record<string, number>>({})

  const toggleModifier = useCallback((mod: Modifier) => {
    const now = Date.now()
    const lastTap = lastModTap.current[mod] ?? 0
    const isDoubleTap = now - lastTap < 400
    lastModTap.current[mod] = now

    if (isDoubleTap) {
      setLockedModifiers((prev) => {
        const next = new Set(prev)
        if (next.has(mod)) next.delete(mod); else next.add(mod)
        return next
      })
      setActiveModifiers((prev) => { const n = new Set(prev); n.delete(mod); return n })
    } else {
      setActiveModifiers((prev) => {
        const next = new Set(prev)
        if (next.has(mod)) next.delete(mod); else next.add(mod)
        return next
      })
    }
  }, [])

  const send = useCallback(
    (seq: string) => {
      const combined = new Set([...activeModifiers, ...lockedModifiers])
      const data = applyModifier(seq, combined)
      onSend(data)
      if (activeModifiers.size > 0) setActiveModifiers(new Set())
    },
    [onSend, activeModifiers, lockedModifiers],
  )

  const modState = (mod: Modifier): ModState => lockedModifiers.has(mod) ? 'locked' : activeModifiers.has(mod) ? 'once' : 'off'
  const togglePanel = (p: Exclude<Panel, 'none'>) => setPanel((v) => v === p ? 'none' : p)
  const panelTabs: { id: Exclude<Panel, 'none'>; label: string }[] = [
    { id: 'fkeys', label: copy.fnKeys }, { id: 'ctrl', label: copy.ctrlKeys }, { id: 'symbols', label: copy.symbols },
  ]

  return (
    <div data-testid="mobile-terminal-toolbar" className="flex flex-col border-t border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center gap-1.5 overflow-x-auto px-2 py-1.5 [scrollbar-width:none]">
        <ToolbarKey label="esc" onPress={() => send('\x1b')} />
        <ToolbarKey label="tab" onPress={() => send('\t')} />
        <ToolbarModifier label="ctrl" state={modState('ctrl')} onPress={() => toggleModifier('ctrl')} />
        <ToolbarModifier label="alt" state={modState('alt')} onPress={() => toggleModifier('alt')} />
        <ToolbarKey label="←" icon={<ArrowLeft className="h-4 w-4" />} onPress={() => send('\x1b[D')} />
        <ToolbarKey label="↑" icon={<ArrowUp className="h-4 w-4" />} onPress={() => send('\x1b[A')} />
        <ToolbarKey label="↓" icon={<ArrowDown className="h-4 w-4" />} onPress={() => send('\x1b[B')} />
        <ToolbarKey label="→" icon={<ArrowRight className="h-4 w-4" />} onPress={() => send('\x1b[C')} />
        <ToolbarToggle label={copy.ctrlKeys} text="^·" active={panel === 'ctrl'} onPress={() => togglePanel('ctrl')} />
        <ToolbarToggle label={copy.symbols} icon={<ChevronsLeftRight className="h-4 w-4" />} active={panel === 'symbols'} onPress={() => togglePanel('symbols')} />
        <ToolbarToggle label={copy.fnKeys} text="Fn" active={panel === 'fkeys'} onPress={() => togglePanel('fkeys')} />
        {QUICK_SYMBOLS.map((ch) => <ToolbarKey key={ch} label={ch} onPress={() => send(ch)} />)}
      </div>

      {panel !== 'none' && (
        <div data-testid="mobile-key-panel" className="border-t border-[color:var(--workspace-border-soft)] px-2 pb-2">
          <div className="flex items-center justify-between py-1.5">
            <div role="tablist" className="flex rounded-lg bg-[var(--workspace-surface-800)] p-0.5">
              {panelTabs.map((tab) => (
                <button key={tab.id} type="button" role="tab" aria-selected={panel === tab.id} onClick={() => setPanel(tab.id)}
                  className={cn('h-9 rounded-md px-3 text-[13px] transition-colors',
                    panel === tab.id ? 'bg-[var(--workspace-surface-700)] font-semibold text-[var(--workspace-text-strong)] shadow-sm' : 'text-[var(--workspace-text-muted)]')}>
                  {tab.label}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setPanel('none')} aria-label={copy.closePanel}
              className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--workspace-text-muted)] active:bg-[var(--workspace-surface-800)]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {panel === 'fkeys' && (
            <div className="grid grid-cols-6 gap-1.5">
              {[...SPECIAL_KEYS, ...NAV_KEYS].map((k) => <PanelKey key={k.label} onPress={() => send(k.seq)}>{k.label}</PanelKey>)}
            </div>
          )}

          {panel === 'ctrl' && (
            <div className="grid grid-cols-4 gap-1.5">
              {CTRL_SHORTCUTS.map((s) => (
                <PanelKey key={s.label} tall onPress={() => onSend(s.code)}>
                  <span className="text-sm font-semibold text-[var(--workspace-text-strong)]">^{s.label}</span>
                  <span className="text-[10px] leading-none text-[var(--workspace-text-muted)]">{copy.ctrlHints[s.label] ?? s.hint}</span>
                </PanelKey>
              ))}
            </div>
          )}

          {panel === 'symbols' && (
            <div className="grid grid-cols-8 gap-1.5">
              {SYMBOL_KEYS.map((ch) => <PanelKey key={ch} onPress={() => send(ch)}>{ch}</PanelKey>)}
            </div>
          )}

          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-[11px] text-[var(--workspace-text-muted)]">
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-3.5 rounded-sm border border-[color:var(--workspace-accent-text)]" aria-hidden="true" />{copy.legendOneShot}</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-3.5 rounded-sm bg-[color:var(--workspace-primary-500)]" aria-hidden="true" />{copy.legendLocked}</span>
          </div>
        </div>
      )}
    </div>
  )
}

const QUICK_SYMBOLS = ['|', '/', '~']
const keyBase = 'flex h-11 shrink-0 items-center justify-center rounded-lg font-mono text-[15px] transition-colors'
const keyIdle = 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-strong)] active:bg-[var(--workspace-surface-700)]'

function pressHandlers(onPress: () => void) {
  return {
    onTouchStart: (e: React.TouchEvent) => { e.preventDefault(); onPress() },
    onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); onPress() },
  }
}

/** 44px key — meets the minimum touch target and keeps focus on the terminal. */
function ToolbarKey({ label, icon, onPress }: { label: string; icon?: ReactNode; onPress: () => void }) {
  return (
    <button type="button" aria-label={label} {...pressHandlers(onPress)} className={cn(keyBase, keyIdle, 'min-w-11 px-2.5')}>
      {icon ?? label}
    </button>
  )
}

/** Modifier key: tap arms it for the next key (outlined), double-tap locks it (filled, underlined). */
function ToolbarModifier({ label, state, onPress }: { label: string; state: ModState; onPress: () => void }) {
  return (
    <button type="button" aria-pressed={state !== 'off'} data-state={state} {...pressHandlers(onPress)}
      className={cn(keyBase, 'relative min-w-12 px-2.5',
        state === 'locked' ? 'bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]'
          : state === 'once' ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)] ring-1 ring-inset ring-[color:var(--workspace-accent-text)]'
            : keyIdle)}
    >
      {label}
      {state === 'locked' && <span className="absolute bottom-1.5 left-1/2 h-[2px] w-5 -translate-x-1/2 rounded-full bg-[var(--workspace-primary-foreground)]" />}
    </button>
  )
}

function ToolbarToggle({ label, text, icon, active, onPress }: { label: string; text?: string; icon?: ReactNode; active: boolean; onPress: () => void }) {
  return (
    <button type="button" aria-label={label} aria-expanded={active} onClick={onPress}
      className={cn(keyBase, 'min-w-11 px-2.5', active ? 'bg-[color:var(--workspace-primary-500)] text-[var(--workspace-primary-foreground)]' : keyIdle)}>
      {icon ?? text}
    </button>
  )
}

function PanelKey({ children, tall, onPress }: { children: ReactNode; tall?: boolean; onPress: () => void }) {
  return (
    <button type="button" {...pressHandlers(onPress)}
      className={cn('flex min-w-0 items-center justify-center rounded-lg font-mono text-[13px]', keyIdle, tall ? 'h-12 flex-col gap-1' : 'h-11')}>
      {children}
    </button>
  )
}
