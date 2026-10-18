import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useT } from '@/lib/i18n'
import type { HostProfile } from '@/lib/hosts'
import { runLocalAlertAction } from '@/lib/local-alert-actions'
import { LOCAL_OPS_PERSISTENCE_EVENT, localOpsPersistenceError } from '@/lib/local-ops-persistence'
import { normalizeLocalAlertRule, type LocalAlertMetric } from '@/lib/local-alert-rules'
import { loadLocalAlertRules, loadLocalAlertState, saveLocalAlertRules, LOCAL_OPS_CHANGED_EVENT } from '@/lib/local-ops-store'

export function LocalAlertRulesPanel({ activeVaultId, hostId, host }: { activeVaultId?: string; hostId: string; host?: HostProfile }) {
  const { t } = useT()
  const [, refresh] = useState(0)
  const [metric, setMetric] = useState<LocalAlertMetric>('cpu')
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [threshold, setThreshold] = useState('90')
  const [recovery, setRecovery] = useState('80')
  const [duration, setDuration] = useState('60')
  const [recoveryDuration, setRecoveryDuration] = useState('30')
  const [severity, setSeverity] = useState<'warning' | 'critical'>('warning')
  const [error, setError] = useState(false)
  const [actionError, setActionError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { const update = () => refresh((n) => n + 1); window.addEventListener(LOCAL_OPS_CHANGED_EVENT, update); window.addEventListener('storage', update); window.addEventListener(LOCAL_OPS_PERSISTENCE_EVENT, update); return () => { window.removeEventListener(LOCAL_OPS_CHANGED_EVENT, update); window.removeEventListener('storage', update); window.removeEventListener(LOCAL_OPS_PERSISTENCE_EVENT, update) } }, [])
  const rules = loadLocalAlertRules(activeVaultId, hostId)
  const state = loadLocalAlertState(activeVaultId, hostId)
  function add() {
    try {
      const rule = normalizeLocalAlertRule({ id: crypto.randomUUID(), hostId, metric, target, name: name || t(`localOps.metric.${metric}`), threshold: Number(threshold), recoveryThreshold: Number(recovery), durationMs: Number(duration) * 1_000, recoveryDurationMs: Number(recoveryDuration) * 1_000, freshnessMs: 180_000, severity, enabled: true })
      saveLocalAlertRules(activeVaultId, hostId, [...rules, rule]); setName(''); setError(false)
    } catch { setError(true) }
  }
  async function act(ruleId: string, action: 'acknowledge' | 'close') {
    if (!host || busy) return
    setBusy(ruleId); setActionError(false)
    try {
      const alert = loadLocalAlertState(activeVaultId, hostId).alerts.find((row) => row.ruleId === ruleId)
      await runLocalAlertAction({ vaultId: activeVaultId, host, ruleId, action, confirmMessage: t(action === 'acknowledge' ? 'localOps.confirmAcknowledge' : 'localOps.confirmClose', { host: host.name, alert: alert?.name ?? ruleId }) })
    } catch { setActionError(true) } finally { setBusy(null) }
  }

  return <section className="space-y-3 border-t border-border/60 pt-4" data-testid="local-alert-rules" data-host-id={hostId} data-vault-id={activeVaultId}>
    <h3 className="text-sm font-semibold">{t('localOps.title')}</h3>
    <p className="text-xs text-muted-foreground">{t('localOps.description')}</p>
    {rules.map((rule) => <div key={rule.id} data-testid="local-rule-row" data-rule-id={rule.id} data-rule-name={rule.name} data-rule-state={state.evaluations.find((row) => row.ruleId === rule.id)?.state ?? 'unknown'} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
      <span className="min-w-24 flex-1">{rule.name} · {t(`localOps.metric.${rule.metric}`)}{rule.target ? ` · ${rule.target}` : ''}</span>
      <span>{rule.metric === 'service' ? t('localOps.serviceFailure') : `≥ ${rule.threshold}% / ≤ ${rule.recoveryThreshold}%`} · {rule.durationMs / 1_000}s / {rule.recoveryDurationMs / 1_000}s</span>
      <span>{t(`localOps.state.${state.evaluations.find((e) => e.ruleId === rule.id)?.state ?? 'unknown'}`)}</span>
      <label><input type="checkbox" checked={rule.enabled} onChange={(e) => saveLocalAlertRules(activeVaultId, hostId, rules.map((r) => r.id === rule.id ? { ...r, enabled: e.target.checked } : r))} /> {t('localOps.enabled')}</label>
      <Button size="sm" variant="ghost" onClick={() => saveLocalAlertRules(activeVaultId, hostId, rules.filter((r) => r.id !== rule.id))}>{t('localOps.remove')}</Button>
    </div>)}
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <label className="text-xs">{t('localOps.metric')}<select data-testid="local-rule-metric" aria-label={t('localOps.metric')} className="mt-1 h-9 w-full rounded-md border bg-background px-2" value={metric} onChange={(e) => setMetric(e.target.value as LocalAlertMetric)}>{(['cpu', 'memory', 'disk', 'service'] as const).map((key) => <option key={key} value={key}>{t(`localOps.metric.${key}`)}</option>)}</select></label>
      <label className="text-xs">{t('localOps.name')}<Input data-testid="local-rule-name" aria-label={t('localOps.name')} value={name} onChange={(e) => setName(e.target.value)} /></label>
      {metric === 'service' ? <label className="text-xs">{t('localOps.service')}<Input data-testid="local-rule-service" aria-label={t('localOps.service')} value={target} placeholder="nginx.service" onChange={(e) => setTarget(e.target.value)} /></label> : <>
        <label className="text-xs">{t('localOps.threshold')}<Input aria-label={t('localOps.threshold')} type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
        <label className="text-xs">{t('localOps.recovery')}<Input aria-label={t('localOps.recovery')} type="number" min={0} max={Number(threshold)} value={recovery} onChange={(e) => setRecovery(e.target.value)} /></label>
      </>}
      <label className="text-xs">{t('localOps.duration')}<Input data-testid="local-rule-duration" aria-label={t('localOps.duration')} type="number" min={0} max={86400} value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
      <label className="text-xs">{t('localOps.recoveryDuration')}<Input data-testid="local-rule-recovery-duration" aria-label={t('localOps.recoveryDuration')} type="number" min={0} max={86400} value={recoveryDuration} onChange={(e) => setRecoveryDuration(e.target.value)} /></label>
      <label className="text-xs">{t('localOps.severity')}<select data-testid="local-rule-severity" aria-label={t('localOps.severity')} className="mt-1 h-9 w-full rounded-md border bg-background px-2" value={severity} onChange={(e) => setSeverity(e.target.value as 'warning' | 'critical')}><option value="warning">{t('localOps.warning')}</option><option value="critical">{t('localOps.critical')}</option></select></label>
      <Button data-testid="local-rule-add" className="self-end" variant="outline" onClick={add} disabled={rules.length >= 32}>{t('localOps.add')}</Button>
    </div>
    {localOpsPersistenceError(activeVaultId, hostId) && <p role="alert" className="text-xs text-red-600">{t('localOps.persistenceFailed')}</p>}
    {actionError && <p role="alert" className="text-xs text-red-600">{t('localOps.actionFailed')}</p>}
    {error && <p role="alert" className="text-xs text-red-600">{t('localOps.invalid')}</p>}
    {state.alerts.slice(-10).reverse().map((alert) => <div key={alert.ruleId} data-testid="local-alert-row" data-rule-id={alert.ruleId} data-alert-status={alert.status} data-alert-name={alert.name} data-transport={alert.transport} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"><span className="flex-1">{alert.name} · {t(`localOps.status.${alert.status}`)} · {alert.source} · {alert.transport}</span>{alert.status === 'active' && <Button size="sm" variant="outline" disabled={!host || busy !== null} onClick={() => void act(alert.ruleId, 'acknowledge')}>{t('localOps.acknowledge')}</Button>}{alert.status !== 'closed' && <Button size="sm" variant="outline" disabled={!host || busy !== null} onClick={() => void act(alert.ruleId, 'close')}>{t('localOps.close')}</Button>}</div>)}
    {state.audit.length > 0 && <details className="text-xs"><summary>{t('localOps.audit')} ({state.audit.length})</summary>{state.audit.slice(-20).reverse().map((row) => <p key={row.id} className="mt-1 text-muted-foreground">{new Date(row.at).toLocaleString()} · {row.name} · {t(`localOps.event.${row.event}`)} · {row.actor}{row.operationJobId ? ` · job=${row.operationJobId}` : ''}</p>)}</details>}
  </section>
}
