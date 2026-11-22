import { Check } from 'lucide-react'
import { ACCENTS, PALETTES, resolveAccent, THEMES, UI_STYLES, useAppearance, type Accent, type PaletteMeta, type ThemeFamily, type UiStyle } from '@/lib/appearance'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

function MiniWorkbenchPreview({ preview }: { preview: PaletteMeta['preview'] }) {
  return (
    <span className="flex flex-1 overflow-hidden" style={{ background: preview.canvas }}>
      {/* Mini sidebar rail */}
      <span className="flex w-3 shrink-0 flex-col items-center gap-1 py-1.5" style={{ background: preview.frame }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: preview.accent }} />
        <span className="h-1 w-1.5 rounded-sm opacity-40" style={{ background: preview.line2 }} />
        <span className="h-1 w-1.5 rounded-sm opacity-30" style={{ background: preview.line2 }} />
      </span>
      {/* Mini terminal + elevated card area */}
      <span className="flex min-w-0 flex-1 flex-col justify-between p-1.5">
        <span className="space-y-1">
          <span className="flex items-center gap-1">
            <span className="h-1 w-2 rounded-full" style={{ background: preview.line1 }} />
            <span className="h-1 flex-1 rounded-full opacity-55" style={{ background: preview.line2 }} />
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1 w-3 rounded-full" style={{ background: preview.line3 }} />
            <span className="h-1 w-2/3 rounded-full opacity-40" style={{ background: preview.line2 }} />
          </span>
        </span>
        <span className="flex items-center justify-between rounded px-1 py-0.5" style={{ background: preview.card }}>
          <span className="h-1 w-5 rounded-full opacity-60" style={{ background: preview.line2 }} />
          <span className="h-1.5 w-3 rounded-full" style={{ background: preview.accent }} />
        </span>
      </span>
    </span>
  )
}

/** Theme gallery (each theme has a dark and a light side) plus interface style and accent override. */
export function AppearancePicker({ family }: { family: ThemeFamily }) {
  const { t } = useT()
  const { prefs, setAppearance } = useAppearance()
  const followsTheme = prefs.darkAccent === null && prefs.lightAccent === null
  const activeAccent = resolveAccent(prefs, family)
  const activePalette = family === 'dark' ? prefs.darkPalette : prefs.lightPalette

  // Miniature cards drawn with each style's own geometry, independent of the active style.
  const STYLE_PREVIEW: Record<Exclude<UiStyle, 'auto'>, { radius: number; border: string; shadow: string; glass?: boolean }> = {
    outline: { radius: 7, border: '1px solid hsl(var(--border))', shadow: 'inset 0 1px 0 rgb(255 255 255 / 0.06)' },
    elevated: { radius: 10, border: '1px solid transparent', shadow: '0 1px 2px rgb(0 0 0 / .06), 0 4px 10px -3px rgb(0 0 0 / .2)' },
    glass: { radius: 10, border: '1px solid hsl(var(--foreground) / .18)', shadow: 'inset 0 1px 0 rgb(255 255 255 / 0.28), 0 4px 12px -4px rgb(0 0 0 / 0.25)', glass: true },
    sharp: { radius: 2, border: '1px solid hsl(var(--foreground) / .25)', shadow: 'none' },
  }
  const styleOption = (style: UiStyle) => {
    const on = prefs.uiStyle === style
    const preview = style === 'auto' ? null : STYLE_PREVIEW[style]
    return (
      <button key={style} type="button" role="radio" aria-checked={on} data-testid={`ui-style-${style}`} onClick={() => setAppearance({ uiStyle: style })}
        className={cn('rounded-lg border p-2 text-left transition-all', on ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-foreground/30')}>
        <span className={cn('relative flex h-10 items-center justify-center gap-1.5 overflow-hidden rounded-md px-2', preview?.glass ? 'bg-gradient-to-br from-primary/25 via-muted/60 to-primary/10' : 'bg-muted/60')}>
          {preview ? <>
            <span className={cn('h-6 flex-1', preview.glass ? 'bg-card/65 backdrop-blur-sm' : 'bg-card')} style={{ borderRadius: preview.radius, border: preview.border, boxShadow: preview.shadow }} />
            <span className={cn('h-6 flex-1', preview.glass ? 'bg-card/65 backdrop-blur-sm' : 'bg-card')} style={{ borderRadius: preview.radius, border: preview.border, boxShadow: preview.shadow }} />
          </> : <span className="text-center text-[10px] leading-tight text-muted-foreground">{t('settings.uiStyleAutoHint')}</span>}
        </span>
        <span className="mt-1.5 flex items-center justify-between text-[11px] font-medium">{t(`settings.uiStyle.${style}`)}{on && <Check className="h-3 w-3 text-primary" />}</span>
      </button>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">{t('settings.uiStyleTitle')}</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" role="radiogroup" aria-label={t('settings.uiStyleTitle')}>
          {(['auto', ...UI_STYLES] as UiStyle[]).map(styleOption)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4" role="radiogroup" aria-label={t('settings.palettes')}>
        {THEMES.map(({ id, label, dark, light }) => {
          const on = activePalette === dark || activePalette === light
          return (
            <button key={id} type="button" role="radio" aria-checked={on} data-testid={`theme-${id}`}
              onClick={() => setAppearance({ darkPalette: dark, lightPalette: light })}
              className={cn('group overflow-hidden rounded-xl border bg-card text-left transition-all', on ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-foreground/30')}>
              <span className="flex h-14 divide-x divide-black/15">
                <MiniWorkbenchPreview preview={PALETTES[dark].preview} />
                <MiniWorkbenchPreview preview={PALETTES[light].preview} />
              </span>
              <span className="flex items-center justify-between border-t border-border/60 px-2.5 py-1.5 text-[11.5px] font-medium">
                <span className="truncate">{label}</span>
                {on && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
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
                className={cn('flex h-6 w-6 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110', on && 'ring-2 ring-foreground/60')}
                style={{ background: ACCENTS[accent] }}>
                {on && <Check className="h-3.5 w-3.5 text-white drop-shadow-sm" />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
