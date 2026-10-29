import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Cpu } from 'lucide-react'
import { AI_PROVIDERS, isAIConfigured, switchAIProvider, type AIProviderId, type AISettings } from '@/lib/ai'
import { CLI_MODEL_PRESETS, currentModelTarget, withModel } from '@/lib/ai-conversation'
import { useT } from '@/lib/i18n'
import { aiAssistantCopy, fillCopy } from '@/lib/locales/ai-assistant'
import { cn } from '@/lib/utils'

type Choice = { key: string; label: string; apply: (settings: AISettings) => AISettings }

function backendChoices(settings: AISettings): Choice[] {
  const choices: Choice[] = [
    { key: 'claude-code', label: 'Claude Code', apply: (s) => ({ ...s, backend: 'claude-code' }) },
    { key: 'codex-cli', label: 'Codex CLI', apply: (s) => ({ ...s, backend: 'codex-cli' }) },
  ]
  for (const provider of AI_PROVIDERS) {
    const apply = (s: AISettings): AISettings => ({ ...switchAIProvider(s, provider.id as AIProviderId), backend: 'api' })
    // Only providers that already have a key or endpoint; setting one up belongs in Settings.
    if (isAIConfigured(apply(settings))) choices.push({ key: `api:${provider.id}`, label: `${provider.name} · API`, apply })
  }
  return choices
}

/** Header control: shows what the next message will use and switches it without leaving the conversation. */
export function AIModelSwitcher({ settings, reportedModel, onChange, disabled }: {
  settings: AISettings
  /** The model a CLI said it used for the last reply, shown when no explicit model is set. */
  reportedModel?: string
  onChange: (settings: AISettings) => void
  disabled?: boolean
}) {
  const { locale } = useT()
  const copy = aiAssistantCopy[locale]
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const target = currentModelTarget(settings)
  const activeKey = target.backend === 'api' ? `api:${settings.provider}` : target.backend
  const modelLabel = target.model || (target.backend === 'api' ? copy.defaultModel : reportedModel || copy.cliDefault)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) } }
    window.addEventListener('pointerdown', onPointer)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('pointerdown', onPointer); window.removeEventListener('keydown', onKey, true) }
  }, [open])

  const presets = target.backend === 'api'
    ? (AI_PROVIDERS.find((provider) => provider.id === settings.provider)?.models ?? [])
    : CLI_MODEL_PRESETS[target.backend]
  const models = target.model && !presets.includes(target.model) ? [target.model, ...presets] : presets
  const applyCustom = () => { const value = custom.trim(); if (value) { onChange(withModel(settings, value)); setCustom('') } }

  return (
    <div ref={root} className="relative min-w-0">
      <button type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} title={copy.modelMenu}
        data-testid="ai-model-switcher" onClick={() => setOpen((value) => !value)}
        className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2 text-xs text-[var(--workspace-text)] transition-colors hover:border-[color:var(--workspace-border-strong)] disabled:opacity-50">
        <Cpu className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]" aria-hidden="true" />
        <span className="shrink-0 font-medium text-[var(--workspace-text-strong)]">{target.providerName}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{modelLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-[var(--workspace-text-subtle)]" aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label={copy.modelMenu}
          className="absolute right-0 top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] p-1.5 text-xs shadow-[var(--workspace-shadow-overlay)]">
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--workspace-text-subtle)]">{copy.backend}</p>
          {backendChoices(settings).map((choice) => (
            <button key={choice.key} type="button" role="menuitemradio" aria-checked={choice.key === activeKey}
              onClick={() => onChange(choice.apply(settings))}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[var(--workspace-text)] hover:bg-[var(--workspace-surface-800)]">
              <Check className={cn('h-3.5 w-3.5 shrink-0 text-[var(--workspace-accent-text)]', choice.key !== activeKey && 'invisible')} aria-hidden="true" />
              <span className="truncate">{choice.label}</span>
            </button>
          ))}
          <div className="my-1.5 border-t border-[color:var(--workspace-border-soft)]" />
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--workspace-text-subtle)]">{copy.model}</p>
          <div className="flex flex-wrap gap-1 px-2">
            {models.map((model) => {
              const active = model === target.model
              return (
                <button key={model || 'default'} type="button" aria-pressed={active} onClick={() => onChange(withModel(settings, model))}
                  className={cn('max-w-full truncate rounded-md border px-2 py-1 font-mono text-[11px] transition-colors',
                    active ? 'border-[color:var(--workspace-primary-500)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]'
                      : 'border-[color:var(--workspace-border-soft)] text-[var(--workspace-text)] hover:border-[color:var(--workspace-border-strong)]')}>
                  {model || (target.backend === 'api' ? copy.defaultModel : copy.cliDefault)}
                </button>
              )
            })}
          </div>
          <div className="mt-2 flex gap-1.5 px-2">
            <input value={custom} onChange={(event) => setCustom(event.target.value)} spellCheck={false}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyCustom() } }}
              placeholder={copy.customModel} aria-label={copy.customModel}
              className="h-7 min-w-0 flex-1 rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] px-2 font-mono text-[11px] text-[var(--workspace-text-strong)] outline-none placeholder:text-[var(--workspace-text-subtle)] focus:border-[color:var(--workspace-primary-500)]" />
            <button type="button" disabled={!custom.trim()} onClick={applyCustom}
              className="h-7 shrink-0 rounded-md bg-[var(--workspace-accent-subtle)] px-2.5 font-medium text-[var(--workspace-accent-text)] disabled:opacity-40">{copy.apply}</button>
          </div>
          {target.backend !== 'api' && !target.model && reportedModel && (
            <p className="px-2 pt-2 text-[11px] text-[var(--workspace-text-muted)]">{fillCopy(copy.reportedModel, { model: reportedModel })}</p>
          )}
          <p className="px-2 pb-1 pt-2 text-[11px] leading-relaxed text-[var(--workspace-text-subtle)]">{copy.appliesNext}</p>
        </div>
      )}
    </div>
  )
}
