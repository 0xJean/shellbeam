import { useRef, useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { checkAICli, cliErrorMessage, type AICliStatus } from '@/lib/ai-cli'
import type { AICliBackend, AICliProfile } from '@/lib/ai'
import { useT } from '@/lib/i18n'

export function AICliSettings({ backend, profile, onChange }: {
  backend: AICliBackend; profile: AICliProfile; onChange: (profile: AICliProfile) => void
}) {
  const { t } = useT()
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
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t('ai.cli.helper')}</p>
    <p className="text-xs text-muted-foreground">{t(backend === 'claude-code' ? 'ai.cli.claudeLogin' : 'ai.cli.codexLogin')}</p>
    <label className="block text-sm text-muted-foreground">
      {t('ai.cli.path')}
      <Input className="mt-1" value={profile.executable} placeholder={t('ai.cli.autoDetect')}
        onChange={(e) => { generation.current++; setBusy(false); setStatus(null); setError(''); onChange({ ...profile, executable: e.target.value }) }} />
    </label>
    <label className="block text-sm text-muted-foreground">
      {t('ai.cli.model')}
      <Input className="mt-1" value={profile.model} placeholder={t('ai.cli.defaultModel')}
        onChange={(e) => onChange({ ...profile, model: e.target.value })} />
    </label>
    <Button type="button" variant="outline" disabled={busy} onClick={() => void check()}>
      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('ai.cli.check')}
    </Button>
    {status && <p role="status" className="break-all text-xs text-muted-foreground">{t('ai.cli.ready', { version: status.version, executable: status.executable })}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <p className="text-xs text-muted-foreground">{t('ai.cli.boundary')}</p>
  </div>
}
