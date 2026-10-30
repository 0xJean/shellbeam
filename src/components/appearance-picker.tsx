import { Check } from 'lucide-react'
import { ACCENTS, PALETTES, resolveAccent, THEMES, UI_STYLES, useAppearance, type Accent, type ThemeFamily, type UiStyle } from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/** Theme gallery (each theme has a dark and a light side) plus a custom accent shared by both. */
export function AppearancePicker({ family }: { family: ThemeFamily }) {
  const { t } = useT()
  const { prefs, setAppearance } = useAppearance()
  const followsTheme = prefs.darkAccent === null && prefs.lightAccent === null
  const activeAccent = resolveAccent(prefs, family)
  const activePalette = family === 'dark' ? prefs.darkPalette : prefs.lightPalette

  // Miniature cards drawn with each style's own geometry, independent of the active style.
  const STYLE_PREVIEW: Record<Exclude<UiStyle, 'auto'>, { radius: number; border: string; shadow: string }> = {
    outline: { radius: 7, border: '1px solid hsl(var(--border))', shadow: 'none' },
    elevated: { radius: 10, border: '1px solid transparent', shadow: '0 1px 2px rgb(0 0 0 / .06), 0 4px 10px -3px rgb(0 0 0 / .18)' },
    sharp: { radius: 2, border: '1px solid hsl(var(--foreground) / .25)', shadow: 'none' },
  }
  const styleOption = (style: UiStyle) => {
    const on = prefs.uiStyle === style
    const preview = style === 'auto' ? null : STYLE_PREVIEW[style]
    return (
      <button key={style} type="button" role="radio" aria-checked={on} data-testid={`ui-style-${style}`} onClick={() => setAppearance({ uiStyle: style })}
        className={cn('rounded-lg border p-2 text-left transition-shadow', on ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-foreground/30')}>
        <span className="flex h-10 items-center justify-center gap-1.5 rounded-md bg-muted/60 px-2">
          {preview ? <>
            <span className="h-6 flex-1 bg-card" style={{ borderRadius: preview.radius, border: preview.border, boxShadow: preview.shadow }} />
            <span className="h-6 flex-1 bg-card" style={{ borderRadius: preview.radius, border: preview.border, boxShadow: preview.shadow }} />
          </> : <span className="text-[10px] text-muted-foreground">{t('settings.uiStyleAutoHint')}</span>}
        </span>
        <span className="mt-1.5 flex items-center justify-between text-[11px] font-medium">{t(`settings.uiStyle.${style}`)}{on && <Check className="h-3 w-3 text-primary" />}</span>
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">{t('settings.uiStyleTitle')}</div>
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label={t('settings.uiStyleTitle')}>
          {(['auto', ...UI_STYLES] as UiStyle[]).map(styleOption)}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label={t('settings.palettes')}>
        {THEMES.map(({ id, label, dark, light }) => {
          const on = activePalette === dark || activePalette === light
          return (
            <button key={id} type="button" role="radio" aria-checked={on} data-testid={`theme-${id}`}
              onClick={() => setAppearance({ darkPalette: dark, lightPalette: light })}
              className={cn('overflow-hidden rounded-lg border text-left transition-shadow', on ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-foreground/30')}>
              <span className="flex h-10">
                {[dark, light].map((palette) => {
                  const { swatch } = PALETTES[palette]
                  return (
                    <span key={palette} className="flex flex-1 items-end gap-1 p-1.5" style={{ background: swatch[0] }}>
                      <span className="h-full flex-1 rounded" style={{ background: swatch[1] }} />
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: swatch[2] }} />
                    </span>
                  )
                })}
              </span>
              <span className="flex items-center justify-between px-2 py-1 text-[11px] font-medium">
                {label}
                {on && <Check className="h-3 w-3 text-primary" />}
              </span>
            </button>
          )
        })}
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">{t('settings.accentColor')}</div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-pressed={followsTheme} onClick={() => setAppearance({ darkAccent: null, lightAccent: null })}
            className={cn('rounded-md border px-2.5 py-1 text-xs font-medium transition-colors', followsTheme ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:border-foreground/30')}>
            {t('settings.accentFollowPalette')}
          </button>
          {(Object.keys(ACCENTS) as Accent[]).map((accent) => {
            const on = !followsTheme && activeAccent === accent
            return (
              <button key={accent} type="button" aria-pressed={on} aria-label={t(`settings.accent.${accent}`)} title={t(`settings.accent.${accent}`)} data-testid={`accent-${accent}`}
                onClick={() => setAppearance({ darkAccent: accent, lightAccent: accent })}
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
