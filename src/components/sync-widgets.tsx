import { useRef } from 'react'
import { Wifi, Monitor, Smartphone, CheckCircle2, Radio } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ScanRadar({ scanning }: { scanning: boolean }) {
  return (
    <div className="relative mx-auto flex h-40 w-40 items-center justify-center">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className={cn(
            'absolute rounded-full border border-primary/20',
            scanning && 'animate-ping',
          )}
          style={{
            width: `${i * 33}%`, height: `${i * 33}%`,
            animationDelay: `${i * 0.4}s`,
            animationDuration: '2.5s',
            opacity: scanning ? undefined : 0.3,
          }}
        />
      ))}
      {[1, 2, 3].map((i) => (
        <div
          key={`s${i}`}
          className="absolute rounded-full border border-primary/10"
          style={{ width: `${i * 33}%`, height: `${i * 33}%` }}
        />
      ))}
      <div className={cn(
        'relative z-10 flex h-14 w-14 items-center justify-center rounded-full',
        scanning ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
      )}>
        {scanning ? (
          <Radio className="h-6 w-6 animate-pulse" />
        ) : (
          <Wifi className="h-6 w-6" />
        )}
      </div>
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
            'flex h-12 w-10 items-center justify-center rounded-lg border-2 bg-background text-center text-lg font-bold text-foreground outline-none transition-all',
            digits[i]?.trim()
              ? 'border-primary shadow-[0_0_8px_rgba(59,130,246,0.3)]'
              : 'border-border',
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
  const Icon = deviceType === 'phone' ? Smartphone : Monitor
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border-2 p-3 text-left transition-all hover:border-primary/50',
        selected ? 'border-primary bg-primary/5' : 'border-border',
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{host}:{port}</p>
      </div>
      {selected && <CheckCircle2 className="h-5 w-5 shrink-0 text-primary" />}
    </button>
  )
}
