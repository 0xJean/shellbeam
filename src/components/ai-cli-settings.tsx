import { useRef, useState, useEffect } from 'react'
import { Info, Loader2, SearchCheck, ShieldCheck } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { checkAICli, cliErrorMessage, type AICliStatus } from '@/lib/ai-cli'
import type { AICliBackend, AICliProfile } from '@/lib/ai'
import { useT } from '@/lib/i18n'
import { aiMcpSettingsCopy } from '@/lib/locales/ai-mcp-settings-v3'

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
  const name = backend === 'claude-code' ? 'Claude Code' : 'Codex CLI'
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
        <label className="block text-xs font-medium text-[var(--workspace-text)]">
          {t('ai.cli.model')}
          <Input className="mt-1.5 font-mono" value={profile.model} placeholder={t('ai.cli.defaultModel')}
            onChange={(e) => onChange({ ...profile, model: e.target.value })} />
        </label>
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
      <p className="flex items-start gap-2"><Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />{t(backend === 'claude-code' ? 'ai.cli.claudeLogin' : 'ai.cli.codexLogin')}</p>
      <p className="flex items-start gap-2"><ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--workspace-status-good-text)]" /><span><span className="font-medium text-[var(--workspace-text)]">{copy.privacyTitle} · </span>{t('ai.cli.boundary')}</span></p>
    </div>
  </div>
}
