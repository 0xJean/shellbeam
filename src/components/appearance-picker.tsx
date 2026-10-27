import { Check } from 'lucide-react'
import { ACCENTS, PALETTES, resolveAccent, useAppearance, type Accent, type Palette, type ThemeFamily } from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** Palette gallery for both theme families plus the accent of the active family. */
export function AppearancePicker({ family }: { family: ThemeFamily }) {
  const { t } = useT()
  const { prefs, setAppearance } = useAppearance()
  const accentKey = family === 'dark' ? 'darkAccent' : 'lightAccent'
  const followsPalette = prefs[accentKey] === null
  const activeAccent = resolveAccent(prefs, family)

  const row = (rowFamily: ThemeFamily) => {
    const selected = rowFamily === 'dark' ? prefs.darkPalette : prefs.lightPalette
    const ids = (Object.keys(PALETTES) as Palette[]).filter((id) => PALETTES[id].family === rowFamily)
    return (
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">{t(rowFamily === 'dark' ? 'settings.darkPalettes' : 'settings.lightPalettes')}</div>
        <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label={t(rowFamily === 'dark' ? 'settings.darkPalettes' : 'settings.lightPalettes')}>
          {ids.map((id) => {
            const { label, swatch } = PALETTES[id]
            const on = selected === id
            return (
              <button key={id} type="button" role="radio" aria-checked={on} data-testid={`palette-${id}`}
                onClick={() => setAppearance(rowFamily === 'dark' ? { darkPalette: id as typeof prefs.darkPalette } : { lightPalette: id as typeof prefs.lightPalette })}
                className={cn('overflow-hidden rounded-lg border text-left transition-shadow', on ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-foreground/30')}>
                <span className="flex h-10 items-end gap-1 p-1.5" style={{ background: swatch[0] }}>
                  <span className="h-full flex-1 rounded" style={{ background: swatch[1] }} />
                  <span className="h-3 w-3 rounded-full" style={{ background: swatch[2] }} />
                </span>
                <span className="flex items-center justify-between px-2 py-1 text-[11px] font-medium">
                  {label}
                  {on && <Check className="h-3 w-3 text-primary" />}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {row('dark')}
      {row('light')}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">{t(family === 'dark' ? 'settings.accentDark' : 'settings.accentLight')}</div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed={followsPalette} onClick={() => setAppearance({ [accentKey]: null })}
            className={cn('rounded-md border px-2.5 py-1 text-xs font-medium transition-colors', followsPalette ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-foreground/30')}>
            {t('settings.accentFollowPalette')}
          </button>
          {(Object.keys(ACCENTS) as Accent[]).map((accent) => {
            const on = !followsPalette && activeAccent === accent
            return (
              <button key={accent} type="button" aria-pressed={on} aria-label={t(`settings.accent.${accent}`)} title={t(`settings.accent.${accent}`)} data-testid={`accent-${accent}`}
                onClick={() => setAppearance({ [accentKey]: accent })}
                className={cn('flex h-6 w-6 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow', on && 'ring-2 ring-foreground/60')}
                style={{ background: ACCENTS[accent] }}>
                {on && <Check className="h-3.5 w-3.5 text-white" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
