import { useRef, useState, useEffect } from 'react'
import { Info, Loader2, SearchCheck, ShieldCheck } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { findLocalAgent } from '@/lib/agents'
import { checkAICli, cliErrorMessage, type AICliStatus } from '@/lib/ai-cli'
import type { AICliBackend, AICliProfile, AIReasoningEffort } from '@/lib/ai'
import { CLI_BACKEND_LABELS, CLI_MODEL_PRESETS } from '@/lib/ai-conversation'
import { useT } from '@/lib/i18n'
import { aiMcpSettingsCopy } from '@/lib/locales/ai-mcp-settings-v3'
import { cn } from '@/lib/utils'

const EFFORT_LEVELS: readonly AIReasoningEffort[] = ['', 'low', 'medium', 'high']

export function AICliSettings({ backend, profile, onChange }: {
  backend: AICliBackend; profile: AICliProfile; onChange: (profile: AICliProfile) => void
}) {
  const { t, locale } = useT()
  const copy = aiMcpSettingsCopy[locale]
  const generation = useRef(0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<AICliStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => () => { generation.current++ }, [])
  const check = async () => {
    const current = ++generation.current
    setBusy(true); setStatus(null); setError('')
    try {
      const result = await checkAICli(backend, profile.executable)
      if (current === generation.current) setStatus(result)
    } catch (err) {
      if (current === generation.current) setError(cliErrorMessage(err))
    } finally { if (current === generation.current) setBusy(false) }
  }
  const name = CLI_BACKEND_LABELS[backend]
  const presets = CLI_MODEL_PRESETS[backend]
  const supportsEffort = Boolean(findLocalAgent(backend)?.supportsEffort)
  const currentEffort = profile.effort ?? ''
  return <div className="grid items-start gap-4 lg:grid-cols-2">
    <div className="sb-card min-w-0">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-3">
        <h4 className="text-sm font-semibold text-[var(--workspace-text-strong)]">{name}</h4>
        <span className="text-xs text-[var(--workspace-text-muted)]">{copy.cliProfileHint}</span>
      </div>
      <div className="space-y-4 p-4">
        <label className="block text-xs font-medium text-[var(--workspace-text)]">
          {t('ai.cli.path')}
          <Input className="mt-1.5 font-mono" value={profile.executable} placeholder={t('ai.cli.autoDetect')}
            onChange={(e) => { generation.current++; setBusy(false); setStatus(null); setError(''); onChange({ ...profile, executable: e.target.value }) }} />
        </label>
        <div className="space-y-2">
          <label className="block text-xs font-medium text-[var(--workspace-text)]">
            {t('ai.cli.model')}
            <Input className="mt-1.5 font-mono" value={profile.model} placeholder={t('ai.cli.defaultModel')}
              onChange={(e) => onChange({ ...profile, model: e.target.value })} />
          </label>
          {presets.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => {
                const active = (profile.model ?? '').trim() === preset
                return (
                  <button key={preset || 'default'} type="button" aria-pressed={active}
                    onClick={() => onChange({ ...profile, model: preset })}
                    className={cn('rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors',
                      active
                        ? 'border-[color:var(--workspace-primary-500)] bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]'
                        : 'border-[color:var(--workspace-border-soft)] text-[var(--workspace-text-muted)] hover:border-[color:var(--workspace-border-strong)] hover:text-[var(--workspace-text-strong)]')}>
                    {preset || t('ai.cli.defaultModel')}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {supportsEffort && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-[var(--workspace-text)]">{copy.effortLabel}</p>
            <div className="flex flex-wrap gap-1.5">
              {EFFORT_LEVELS.map((level) => {
                const active = currentEffort === level
                return (
                  <button key={level || 'default'} type="button" aria-pressed={active}
                    onClick={() => onChange({ ...profile, effort: level })}
                    className={cn('rounded-md border px-2.5 py-1 text-xs transition-colors',
                      active
                        ? 'border-[color:var(--workspace-primary-500)] bg-[var(--workspace-accent-subtle)] font-medium text-[var(--workspace-accent-text)]'
                        : 'border-[color:var(--workspace-border-soft)] text-[var(--workspace-text-muted)] hover:border-[color:var(--workspace-border-strong)] hover:text-[var(--workspace-text-strong)]')}>
                    {copy.effortOptions[level]}
                  </button>
                )
              })}
            </div>
            <p className="text-[11px] text-[var(--workspace-text-subtle)]">{copy.effortHint}</p>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-[color:var(--workspace-border-soft)] px-4 py-3">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
          {busy ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <SearchCheck aria-hidden className="mr-2 h-3.5 w-3.5" />}{t('ai.cli.check')}
        </Button>
        {status && <p role="status" className="flex min-w-0 flex-1 items-start gap-1.5 break-all text-xs text-[var(--workspace-status-good-text)]"><span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--workspace-status-good)]" />{t('ai.cli.ready', { version: status.version, executable: status.executable })}</p>}
        {error && <p role="alert" className="min-w-0 flex-1 text-xs text-[var(--workspace-status-bad-text)]">{error}</p>}
      </div>
    </div>
    <div className="sb-card space-y-3 p-4 text-xs leading-relaxed text-[var(--workspace-text-muted)]">
      <p className="flex items-start gap-2"><Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />{t('ai.cli.helper')}</p>
      <p className="flex items-start gap-2"><Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />{copy.cliLoginHint[backend]}</p>
      <p className="flex items-start gap-2"><ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-status-good-text)]" /><span><span className="font-medium text-[var(--workspace-text)]">{copy.privacyTitle} · </span>{t('ai.cli.boundary')}</span></p>
    </div>
  </div>
}
