import { cn } from '@/lib/utils'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

interface MobileTerminalToolbarProps {
  onSend: (data: string) => void
}

type Modifier = 'ctrl' | 'alt'

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
  const [activeModifiers, setActiveModifiers] = useState<Set<Modifier>>(new Set())
  const [lockedModifiers, setLockedModifiers] = useState<Set<Modifier>>(new Set())
  const [panel, setPanel] = useState<'none' | 'fkeys' | 'ctrl' | 'symbols'>('none')
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

  const isModActive = (mod: Modifier) => activeModifiers.has(mod) || lockedModifiers.has(mod)
  const isModLocked = (mod: Modifier) => lockedModifiers.has(mod)

  const togglePanel = (p: typeof panel) => setPanel((v) => v === p ? 'none' : p)

  return (
    <div className="flex flex-col border-t border-border/50 bg-background/95 backdrop-blur-sm md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* Expandable panel area */}
      {panel !== 'none' && (
        <div className="border-b border-border/30">
          {/* Panel header */}
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {panel === 'fkeys' ? 'Function Keys' : panel === 'ctrl' ? 'Ctrl Shortcuts' : 'Symbols'}
            </span>
            <button type="button" onClick={() => setPanel('none')}
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground active:bg-muted">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {panel === 'fkeys' && (
            <div className="px-2 pb-2">
              <div className="grid grid-cols-6 gap-1.5">
                {SPECIAL_KEYS.map((k) => (
                  <button key={k.label} type="button"
                    onTouchStart={(e) => { e.preventDefault(); send(k.seq) }}
                    onMouseDown={(e) => { e.preventDefault(); send(k.seq) }}
                    className="flex h-10 items-center justify-center rounded-lg bg-muted/60 text-xs font-medium text-foreground transition-colors active:bg-primary/20"
                  >{k.label}</button>
                ))}
              </div>
              <div className="mt-1.5 grid grid-cols-6 gap-1.5">
                {NAV_KEYS.map((k) => (
                  <button key={k.label} type="button"
                    onTouchStart={(e) => { e.preventDefault(); send(k.seq) }}
                    onMouseDown={(e) => { e.preventDefault(); send(k.seq) }}
                    className="flex h-10 items-center justify-center rounded-lg bg-muted/60 text-[11px] font-medium text-muted-foreground transition-colors active:bg-primary/20 active:text-foreground"
                  >{k.label}</button>
                ))}
              </div>
            </div>
          )}

          {panel === 'ctrl' && (
            <div className="grid grid-cols-4 gap-1.5 px-2 pb-2">
              {CTRL_SHORTCUTS.map((s) => (
                <button key={s.label} type="button"
                  onTouchStart={(e) => { e.preventDefault(); onSend(s.code) }}
                  onMouseDown={(e) => { e.preventDefault(); onSend(s.code) }}
                  className="flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg bg-muted/60 transition-colors active:bg-primary/20"
                >
                  <span className="text-sm font-bold text-foreground">^{s.label}</span>
                  <span className="text-[9px] leading-none text-muted-foreground">{s.hint}</span>
                </button>
              ))}
            </div>
          )}

          {panel === 'symbols' && (
            <div className="grid grid-cols-8 gap-1.5 px-2 pb-2">
              {SYMBOL_KEYS.map((ch) => (
                <button key={ch} type="button"
                  onTouchStart={(e) => { e.preventDefault(); send(ch) }}
                  onMouseDown={(e) => { e.preventDefault(); send(ch) }}
                  className="flex h-10 items-center justify-center rounded-lg bg-muted/60 text-sm font-medium text-foreground transition-colors active:bg-primary/20"
                >{ch}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main toolbar: single row with essential keys */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        {/* ESC */}
        <ToolbarKey label="ESC" onPress={() => send('\x1b')} />
        {/* TAB */}
        <ToolbarKey label="TAB" onPress={() => send('\t')} />

        {/* Modifiers */}
        <ToolbarModifier label="CTL" active={isModActive('ctrl')} locked={isModLocked('ctrl')}
          onPress={() => toggleModifier('ctrl')} />
        <ToolbarModifier label="ALT" active={isModActive('alt')} locked={isModLocked('alt')}
          onPress={() => toggleModifier('alt')} />

        {/* Separator */}
        <div className="mx-0.5 h-5 w-px shrink-0 bg-border/40" />

        {/* Arrow keys */}
        <ToolbarKey icon={<ArrowLeft className="h-4 w-4" />} onPress={() => send('\x1b[D')} />
        <ToolbarKey icon={<ArrowUp className="h-4 w-4" />} onPress={() => send('\x1b[A')} />
        <ToolbarKey icon={<ArrowDown className="h-4 w-4" />} onPress={() => send('\x1b[B')} />
        <ToolbarKey icon={<ArrowRight className="h-4 w-4" />} onPress={() => send('\x1b[C')} />

        {/* Spacer */}
        <div className="flex-1" />

        {/* Panel toggles */}
        <ToolbarToggle label="^·" active={panel === 'ctrl'} onPress={() => togglePanel('ctrl')} />
        <ToolbarToggle
          icon={panel === 'symbols' ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          active={panel === 'symbols'} onPress={() => togglePanel('symbols')} />
        <ToolbarToggle label="Fn" active={panel === 'fkeys'} onPress={() => togglePanel('fkeys')} />
      </div>
    </div>
  )
}

/** 44px tall key button — meets Apple HIG minimum touch target */
function ToolbarKey({ label, icon, onPress }: {
  label?: string
  icon?: React.ReactNode
  onPress: () => void
}) {
  return (
    <button type="button"
      onTouchStart={(e) => { e.preventDefault(); onPress() }}
      onMouseDown={(e) => { e.preventDefault(); onPress() }}
      className="flex h-9 shrink-0 items-center justify-center rounded-lg bg-muted/70 px-2.5 text-xs font-semibold text-foreground transition-colors active:bg-primary/20"
      style={{ minWidth: 36 }}
    >
      {icon ?? label}
    </button>
  )
}

/** Modifier key with active/locked state */
function ToolbarModifier({ label, active, locked, onPress }: {
  label: string
  active: boolean
  locked: boolean
  onPress: () => void
}) {
  return (
    <button type="button"
      onTouchStart={(e) => { e.preventDefault(); onPress() }}
      onMouseDown={(e) => { e.preventDefault(); onPress() }}
      className={cn(
        'relative flex h-9 shrink-0 items-center justify-center rounded-lg px-2.5 text-xs font-bold transition-colors',
        active
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'bg-muted/70 text-muted-foreground active:bg-muted',
      )}
      style={{ minWidth: 36 }}
    >
      {label}
      {locked && <span className="absolute -bottom-0.5 left-1/2 h-[2px] w-4 -translate-x-1/2 rounded-full bg-primary-foreground" />}
    </button>
  )
}

/** Panel toggle button */
function ToolbarToggle({ label, icon, active, onPress }: {
  label?: string
  icon?: React.ReactNode
  active: boolean
  onPress: () => void
}) {
  return (
    <button type="button"
      onClick={onPress}
      className={cn(
        'flex h-9 shrink-0 items-center justify-center rounded-lg px-2 text-xs font-bold transition-colors',
        active ? 'bg-primary/20 text-primary' : 'bg-muted/70 text-muted-foreground active:bg-muted',
      )}
      style={{ minWidth: 36 }}
    >
      {icon ?? label}
    </button>
  )
}
