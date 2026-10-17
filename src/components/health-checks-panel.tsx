import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import {
  loadHealthChecks,
  normalizeHealthCheck,
  runHealthCheck,
  runHealthCheckBatch,
  saveHealthChecks,
  type HealthCheckDefinition,
  type HealthCheckResult,
} from '@/lib/health-checks'
import { CheckCircle2, CircleAlert, Clock3, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

export interface HealthChecksPanelProps {
  activeVaultId?: string
  host: HostProfile
  resolveAuthSecret: (host: HostProfile) => Promise<string>
}

function resultLabel(result: HealthCheckResult | undefined, t: (key: string) => string) {
  if (!result) return t('workspace.healthChecks.notRun')
  return t(`workspace.healthChecks.status.${result.status}`)
}

export function HealthChecksPanel({ activeVaultId, host, resolveAuthSecret }: HealthChecksPanelProps) {
  const { t } = useT()
  const [checks, setChecks] = useState<HealthCheckDefinition[]>(() => loadHealthChecks(activeVaultId, host))
  const [results, setResults] = useState<Record<string, HealthCheckResult>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftKind, setDraftKind] = useState<'tcp' | 'http'>('tcp')
  const [draftName, setDraftName] = useState('')
  const [draftTarget, setDraftTarget] = useState(host.address)
  const [draftPort, setDraftPort] = useState(String(host.port || 22))

  useEffect(() => {
    const loaded = loadHealthChecks(activeVaultId, host)
    setChecks(loaded)
    setResults({})
    setDraftTarget(host.address)
    setDraftPort(String(host.port || 22))
    setDraftName('')
  }, [activeVaultId, host])

  const enabledCount = useMemo(() => checks.filter((check) => check.enabled).length, [checks])

  function persist(next: HealthCheckDefinition[]) {
    try {
      const normalized = saveHealthChecks(activeVaultId, host.id, next)
      setChecks(normalized)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function addCheck() {
    try {
      const id = `${host.id}:${Date.now()}`
      const check = normalizeHealthCheck({
        id,
        hostId: host.id,
        name: draftName.trim() || (draftKind === 'tcp' ? t('workspace.healthChecks.defaultTcp') : t('workspace.healthChecks.defaultHttp')),
        kind: draftKind,
        target: draftKind === 'http' ? draftTarget : draftTarget.trim(),
        port: draftKind === 'tcp' ? Number(draftPort) : undefined,
        timeoutMs: 10_000,
        intervalMs: 60_000,
        enabled: true,
      })
      persist([...checks, check])
      setDraftName('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function runAll() {
    setRunning(true)
    setError(null)
    try {
      const batch = await runHealthCheckBatch(checks, {
        previous: results,
        ttlMs: 0,
        run: (check) => runHealthCheck({ host, check, resolveAuthSecret }),
      })
      setResults((current) => ({ ...current, ...Object.fromEntries(batch.results.map((result) => [result.checkId, result])) }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-card px-4 py-4" data-testid="health-checks-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><CircleAlert className="h-4 w-4" />{t('workspace.healthChecks.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('workspace.healthChecks.description')}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void runAll()} disabled={running || enabledCount === 0}>
          <RefreshCw className={running ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'} />{running ? t('workspace.healthChecks.running') : t('workspace.healthChecks.run')}
        </Button>
      </div>

      <div className="space-y-2">
        {checks.map((check) => {
          const result = results[check.id]
          return (
            <div key={check.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-xs">
              {result?.status === 'passing' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleAlert className="h-4 w-4 text-muted-foreground" />}
              <div className="min-w-[8rem] flex-1">
                <div className="font-medium">{check.name}</div>
                <div className="text-[11px] text-muted-foreground">{check.kind.toUpperCase()} · {check.target}{check.kind === 'tcp' ? `:${check.port}` : ''}</div>
              </div>
              <span className="rounded-full border px-2 py-1 text-[10px]">{resultLabel(result, t)}</span>
              {result?.latencyMs != null && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Clock3 className="h-3 w-3" />{result.latencyMs} ms</span>}
              {result?.errorSummary && <span className="max-w-[14rem] truncate text-[11px] text-red-600" title={result.errorSummary}>{result.errorSummary}</span>}
              <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <input type="checkbox" checked={check.enabled} onChange={(event) => persist(checks.map((item) => item.id === check.id ? { ...item, enabled: event.target.checked } : item))} />
                {t('workspace.healthChecks.enabled')}
              </label>
              <button type="button" aria-label={t('workspace.healthChecks.remove')} className="rounded p-1 text-muted-foreground hover:text-red-600" onClick={() => persist(checks.filter((item) => item.id !== check.id))}><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          )
        })}
      </div>

      <div className="grid gap-2 rounded-lg border border-dashed border-border/60 p-3 sm:grid-cols-[auto_1fr_1.5fr_auto_auto]">
        <select aria-label={t('workspace.healthChecks.kind')} value={draftKind} onChange={(event) => setDraftKind(event.target.value as 'tcp' | 'http')} className="h-9 rounded-md border bg-background px-2 text-xs">
          <option value="tcp">TCP</option>
          <option value="http">HTTP</option>
        </select>
        <Input aria-label={t('workspace.healthChecks.name')} placeholder={t('workspace.healthChecks.name')} value={draftName} onChange={(event) => setDraftName(event.target.value)} />
        <Input aria-label={t('workspace.healthChecks.target')} placeholder={draftKind === 'http' ? 'https://example.com/health' : host.address} value={draftTarget} onChange={(event) => setDraftTarget(event.target.value)} />
        {draftKind === 'tcp' && <Input aria-label={t('workspace.healthChecks.port')} type="number" min={1} max={65535} value={draftPort} onChange={(event) => setDraftPort(event.target.value)} />}
        <Button type="button" size="sm" variant="outline" onClick={addCheck}><Plus className="mr-1 h-3.5 w-3.5" />{t('workspace.healthChecks.add')}</Button>
      </div>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </section>
  )
}

export default HealthChecksPanel
