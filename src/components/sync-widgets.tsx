import { useRef } from 'react'
import { Laptop, Monitor, Smartphone, CheckCircle2 } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { syncBackupCopy } from '@/lib/locales/sync-backup-v3'
import { cn } from '@/lib/utils'

export function ScanRadar({ scanning, found = 0 }: { scanning: boolean; found?: number }) {
  const dots = [{ top: '22%', left: '17%' }, { top: '62%', left: '86%' }, { top: '84%', left: '30%' }, { top: '12%', left: '70%' }].slice(0, Math.min(found, 4))
  return (
    <div className="relative mx-auto flex h-48 w-48 items-center justify-center" aria-hidden="true">
      {[100, 66, 36].map((size, i) => (
        <div key={size} className="absolute rounded-full border" style={{ width: `${size}%`, height: `${size}%`, borderColor: 'color-mix(in srgb, var(--workspace-accent-text) 35%, transparent)' }}>
          {scanning && i === 0 && <div className="absolute inset-0 animate-ping rounded-full border border-[color:var(--workspace-accent-text)] opacity-30" style={{ animationDuration: '2.5s' }} />}
        </div>
      ))}
      {dots.map((pos, i) => (
        <span key={i} className="absolute h-2.5 w-2.5 rounded-full bg-[color:var(--workspace-status-good)] shadow-[0_0_8px_var(--workspace-status-good)]" style={pos} />
      ))}
      <div className={cn('relative z-10 flex h-11 w-11 items-center justify-center rounded-xl text-white', scanning ? 'bg-[color:var(--workspace-primary-500)]' : 'bg-[var(--workspace-surface-700)] text-[var(--workspace-text-muted)]')}>
        <Laptop className={cn('h-5 w-5', scanning && 'animate-pulse')} />
      </div>
    </div>
  )
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-[color:var(--workspace-primary-500)]' : 'bg-[var(--workspace-surface-700)]')}>
      <span className={cn('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  )
}

export function CodeDigits({ code, label }: { code: string; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex items-center justify-center gap-2">
      {code.split('').map((digit, i) => (
        <span key={i} className="flex h-14 w-11 items-center justify-center rounded-lg bg-[var(--workspace-surface-800)] font-mono text-[26px] font-semibold text-[var(--workspace-text-strong)]">{digit}</span>
      ))}
    </div>
  )
}

export function PinInput({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const digits = value.padEnd(6, '').slice(0, 6).split('')

  function handleChange(idx: number, char: string) {
    if (!/^\d?$/.test(char)) return
    const next = [...digits]
    next[idx] = char
    onChange(next.join('').replace(/ /g, ''))
    if (char && idx < 5) refs.current[idx + 1]?.focus()
  }

  function handleKeyDown(idx: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !digits[idx] && idx > 0) {
      refs.current[idx - 1]?.focus()
    }
  }

  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={digits[i]?.trim() || ''}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          disabled={disabled}
          className={cn(
            'flex h-12 w-10 items-center justify-center rounded-lg border-2 bg-[var(--workspace-surface-800)] text-center text-lg font-bold text-[var(--workspace-text-strong)] outline-none transition-all',
            digits[i]?.trim() ? 'border-[color:var(--workspace-primary-500)]' : 'border-[color:var(--workspace-border-soft)]',
            disabled && 'opacity-50',
          )}
        />
      ))}
    </div>
  )
}

export function DeviceCard({ name, host, port, deviceType, onClick, selected }: {
  name: string; host: string; port: number; deviceType?: string; onClick: () => void; selected?: boolean
}) {
  const { locale } = useT()
  const copy = syncBackupCopy[locale] ?? syncBackupCopy['zh-CN']
  const Icon = deviceType === 'phone' ? Smartphone : Monitor
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 border-b border-[color:var(--workspace-border-soft)] px-4 py-3 text-left transition-colors hover:bg-[var(--workspace-surface-800)]',
        selected && 'bg-[var(--workspace-accent-subtle)]',
      )}
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-[var(--workspace-text-strong)]">{name}</p>
        <p className="truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{host}:{port}</p>
      </div>
      {selected
        ? <CheckCircle2 className="h-5 w-5 shrink-0 text-[color:var(--workspace-accent-text)]" />
        : <span className="shrink-0 rounded-md bg-[color:var(--workspace-primary-500)] px-2.5 py-1 text-[12px] font-medium text-white">{copy.pair}</span>}
    </button>
  )
}
