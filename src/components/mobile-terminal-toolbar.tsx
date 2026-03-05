import { useState, useCallback, useRef } from 'react'
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MobileTerminalToolbarProps {
  onSend: (data: string) => void
  onToggleAI?: () => void
  showAI?: boolean
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
  { label: 'A', hint: 'Line start', code: '\x01' },
  { label: 'E', hint: 'Line end', code: '\x05' },
  { label: 'R', hint: 'History', code: '\x12' },
  { label: 'W', hint: 'Del word', code: '\x17' },
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

export function MobileTerminalToolbar({ onSend, onToggleAI, showAI }: MobileTerminalToolbarProps) {
  const [activeModifiers, setActiveModifiers] = useState<Set<Modifier>>(new Set())
  const [lockedModifiers, setLockedModifiers] = useState<Set<Modifier>>(new Set())
  const [extraPanel, setExtraPanel] = useState<'none' | 'fkeys' | 'ctrl'>('none')
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

  const allActiveModifiers = new Set([...activeModifiers, ...lockedModifiers])

  const send = useCallback(
    (seq: string) => {
      const data = applyModifier(seq, allActiveModifiers)
      onSend(data)
      if (activeModifiers.size > 0) setActiveModifiers(new Set())
    },
    [onSend, allActiveModifiers, activeModifiers],
  )

  const isModActive = (mod: Modifier) => activeModifiers.has(mod) || lockedModifiers.has(mod)
  const isModLocked = (mod: Modifier) => lockedModifiers.has(mod)

  const modBtn = (mod: Modifier, label: string) => (
    <button
      type="button"
      onTouchStart={(e) => { e.preventDefault(); toggleModifier(mod) }}
      onMouseDown={(e) => { e.preventDefault(); toggleModifier(mod) }}
      className={cn(
        'relative flex h-7 shrink-0 items-center justify-center rounded px-1.5 text-[10px] font-bold transition-colors',
        isModActive(mod)
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'bg-muted/80 text-muted-foreground active:bg-muted',
      )}
    >
      {label}
      {isModLocked(mod) && <span className="absolute -bottom-0.5 left-1/2 h-[2px] w-3 -translate-x-1/2 rounded-full bg-primary-foreground" />}
    </button>
  )

  const keyBtn = (label: string | React.ReactNode, seq: string, extraClass?: string) => (
    <button
      type="button"
      onTouchStart={(e) => { e.preventDefault(); send(seq) }}
      onMouseDown={(e) => { e.preventDefault(); send(seq) }}
      className={cn(
        'flex h-7 shrink-0 items-center justify-center rounded bg-muted/80 px-1 text-[10px] font-medium text-foreground transition-colors active:bg-primary/20',
        typeof label === 'string' && label.length <= 2 ? 'min-w-[28px]' : 'min-w-[32px]',
        extraClass,
      )}
    >
      {label}
    </button>
  )

  const sep = <div className="mx-px h-4 w-px shrink-0 bg-border/40" />

  return (
    <div className="flex flex-col border-t border-border/50 bg-background/95 backdrop-blur-sm md:hidden">
      {extraPanel === 'fkeys' && (
        <div className="flex gap-1.5 overflow-x-auto px-2 py-1.5 scrollbar-none">
          {SPECIAL_KEYS.map((k) => (
            <button key={k.label} type="button"
              onTouchStart={(e) => { e.preventDefault(); send(k.seq) }}
              onMouseDown={(e) => { e.preventDefault(); send(k.seq) }}
              className="flex h-7 shrink-0 items-center justify-center rounded bg-muted/60 px-2 text-[10px] font-medium text-muted-foreground transition-colors active:bg-primary/20 active:text-foreground"
            >{k.label}</button>
          ))}
        </div>
      )}

      {extraPanel === 'ctrl' && (
        <div className="flex gap-1.5 overflow-x-auto px-2 py-1.5 scrollbar-none">
          {CTRL_SHORTCUTS.map((s) => (
            <button key={s.label} type="button"
              onTouchStart={(e) => { e.preventDefault(); onSend(s.code) }}
              onMouseDown={(e) => { e.preventDefault(); onSend(s.code) }}
              className="flex h-7 shrink-0 flex-col items-center justify-center rounded bg-muted/60 px-2.5 transition-colors active:bg-primary/20 active:text-foreground"
            >
              <span className="text-[11px] font-bold text-foreground">^{s.label}</span>
              <span className="text-[8px] leading-none text-muted-foreground">{s.hint}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-0.5 px-1.5 py-1">
        <div className="relative min-w-0 flex-1">
          <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none" style={{ WebkitOverflowScrolling: 'touch' }}>
            {keyBtn('ESC', '\x1b')}
            {keyBtn('TAB', '\t')}
            {modBtn('ctrl', 'CTRL')}
            {modBtn('alt', 'ALT')}
            {sep}
            {keyBtn(<ArrowLeft className="h-3 w-3" />, '\x1b[D')}
            {keyBtn(<ArrowUp className="h-3 w-3" />, '\x1b[A')}
            {keyBtn(<ArrowDown className="h-3 w-3" />, '\x1b[B')}
            {keyBtn(<ArrowRight className="h-3 w-3" />, '\x1b[C')}
            {sep}
            {keyBtn('|', '|')}
            {keyBtn('/', '/')}
            {keyBtn('\\', '\\')}
            {keyBtn('~', '~')}
            {keyBtn('-', '-')}
            {keyBtn('_', '_')}
            <div className="w-1 shrink-0" />
          </div>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background/95 to-transparent" />
        </div>

        <div className="flex shrink-0 items-center gap-0.5 pl-0.5">
          {onToggleAI && (
            <button type="button"
              onTouchStart={(e) => { e.preventDefault(); onToggleAI() }}
              onMouseDown={(e) => { e.preventDefault(); onToggleAI() }}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-[10px] transition-all',
                showAI
                  ? 'bg-primary/25 text-blue-300 shadow-[0_0_10px_rgba(19,91,236,0.25)]'
                  : 'border border-primary/30 bg-primary/10 text-primary active:bg-primary/20',
              )}
            >
              <Sparkles className={cn('h-3 w-3', showAI && 'animate-pulse')} />
            </button>
          )}
          <button type="button"
            onClick={() => setExtraPanel((v) => v === 'ctrl' ? 'none' : 'ctrl')}
            className={cn(
              'flex h-7 items-center justify-center rounded px-1 text-[10px] font-bold transition-colors',
              extraPanel === 'ctrl' ? 'bg-primary/20 text-primary' : 'bg-muted/80 text-muted-foreground active:bg-muted',
            )}
          >^·</button>
          <button type="button"
            onClick={() => setExtraPanel((v) => v === 'fkeys' ? 'none' : 'fkeys')}
            className={cn(
              'flex h-7 items-center justify-center rounded px-1 text-[10px] font-medium transition-colors',
              extraPanel === 'fkeys' ? 'bg-primary/20 text-primary' : 'bg-muted/80 text-muted-foreground active:bg-muted',
            )}
          >Fn</button>
        </div>
      </div>
    </div>
  )
}
