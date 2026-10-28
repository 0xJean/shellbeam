import { NativeSelect } from '@/components/ui/select'
import { hasSshConnection } from '@/lib/hosts'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { MAX_BATCH_HOSTS } from '@/lib/multi-host-operations'
import { CheckCircle2, CircleAlert, Loader2, Play, RotateCcw, Server, Wrench } from 'lucide-react'
import { hostOverlaysCopy } from '@/lib/locales/host-overlays-v3'
import { fill } from '@/lib/locales/probe-install'

/** Operations intentionally exposed by the first finite batch slice. The
 * orchestration bridge is responsible for creating one OperationJob per host
 * and preserving its ProxyJump/provider metadata. */
export type MultiHostOperationKind = 'health-check' | 'docker.restart' | 'service.restart'

export interface MultiHostOperationRequest {
  operation: MultiHostOperationKind
  hostIds: string[]
  target?: string
  confirmationRequired: boolean
}

export type MultiHostOperationHostStatus = 'queued' | 'running' | 'completed' | 'failed' | 'unknown' | 'cancelled'
export type MultiHostOperationStatus = 'completed' | 'partial' | 'failed' | 'unknown' | 'cancelled'

export interface MultiHostOperationHostResult {
  hostId: string
  status: MultiHostOperationHostStatus
  jobId?: string | null
  auditId?: string | null
  transport?: 'direct' | 'proxy-jump'
  resultSummary?: string | null
  errorSummary?: string | null
}

export interface MultiHostOperationResult {
  operation: MultiHostOperationKind
  status: MultiHostOperationStatus
  results: MultiHostOperationHostResult[]
  startedAt?: number | null
  finishedAt?: number | null
}

export interface MultiHostOperationsPanelProps {
  hosts: HostProfile[]
  onRunOperation: (request: MultiHostOperationRequest) => Promise<MultiHostOperationResult>
  maxHosts?: number
  initialSelectedHostIds?: string[]
  initialOperation?: MultiHostOperationKind
  /** The host list owns selection; do not render a second host picker. */
  selectionFromList?: boolean
  disabled?: boolean
  className?: string
}

const OPERATION_META: Array<{ value: MultiHostOperationKind; labelKey: string; descriptionKey: string; confirmation: boolean; target: boolean }> = [
  { value: 'health-check', labelKey: 'multiHost.operations.healthCheck', descriptionKey: 'multiHost.operations.healthCheckDescription', confirmation: false, target: false },
  { value: 'docker.restart', labelKey: 'multiHost.operations.dockerRestart', descriptionKey: 'multiHost.operations.dockerRestartDescription', confirmation: true, target: true },
  { value: 'service.restart', labelKey: 'multiHost.operations.serviceRestart', descriptionKey: 'multiHost.operations.serviceRestartDescription', confirmation: true, target: true },
]

type Tone = 'good' | 'warn' | 'bad' | 'info' | 'idle'
function statusTone(status: MultiHostOperationHostStatus | MultiHostOperationStatus): Tone {
  if (status === 'completed') return 'good'
  if (status === 'failed') return 'bad'
  if (status === 'unknown' || status === 'partial') return 'warn'
  if (status === 'running') return 'info'
  return 'idle'
}
const toneText: Record<Tone, string> = { good: 'text-[var(--workspace-status-good-text)]', warn: 'text-[var(--workspace-status-warn-text)]', bad: 'text-[var(--workspace-status-bad-text)]', info: 'text-[var(--workspace-status-info-text)]', idle: 'text-[var(--workspace-text-muted)]' }
const toneDot: Record<Tone, string> = { good: 'bg-[var(--workspace-status-good)]', warn: 'bg-[var(--workspace-status-warn)]', bad: 'bg-[var(--workspace-status-bad)]', info: 'bg-[var(--workspace-status-info)]', idle: 'bg-[var(--workspace-text-subtle)]' }
const toneBanner: Record<Tone, string> = { good: 'bg-[var(--workspace-status-good-bg)]', warn: 'bg-[var(--workspace-status-warn-bg)]', bad: 'bg-[var(--workspace-status-bad-bg)]', info: 'bg-[var(--workspace-status-info-bg)]', idle: 'bg-[var(--workspace-surface-800)]' }

function commandFor(operation: MultiHostOperationKind, target: string) {
  return operation === 'docker.restart' ? `docker restart ${target || '…'}` : operation === 'service.restart' ? `systemctl restart ${target || '…'}` : 'uptime'
}

export function MultiHostOperationsPanel({
  hosts,
  onRunOperation,
  maxHosts = MAX_BATCH_HOSTS,
  initialSelectedHostIds = [],
  initialOperation = 'health-check',
  selectionFromList = false,
  disabled = false,
  className,
}: MultiHostOperationsPanelProps) {
  const { t, locale } = useT()
  const v3 = hostOverlaysCopy[locale]
  const boundedMax = Math.max(1, Math.min(MAX_BATCH_HOSTS, Number.isFinite(maxHosts) ? Math.floor(maxHosts) : MAX_BATCH_HOSTS))
  const hostIds = useMemo(() => new Set(hosts.map((host) => host.id)), [hosts])
  const [selectedHostIds, setSelectedHostIds] = useState<string[]>(() => initialSelectedHostIds.filter((id) => hostIds.has(id)).slice(0, boundedMax))
  const [operation, setOperation] = useState<MultiHostOperationKind>(initialOperation)
  const [target, setTarget] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<MultiHostOperationResult | null>(null)
  const [ranTarget, setRanTarget] = useState('')

  const operationMeta = OPERATION_META.find((item) => item.value === operation) ?? OPERATION_META[0]

  useEffect(() => {
    setSelectedHostIds((current) => current.filter((id) => hostIds.has(id)).slice(0, boundedMax))
  }, [boundedMax, hostIds])

  function toggleHost(hostId: string) {
    setError('')
    setSelectedHostIds((current) => {
      if (current.includes(hostId)) return current.filter((id) => id !== hostId)
      if (current.length >= boundedMax) {
        setError(t('multiHost.maxHostsError', { count: boundedMax }))
        return current
      }
      return [...current, hostId]
    })
  }

  function selectAll() {
    setError('')
    setSelectedHostIds(hosts.slice(0, boundedMax).map((host) => host.id))
  }

  async function run(onlyHostIds?: string[]) {
    const hostIds = onlyHostIds ?? selectedHostIds
    setError('')
    setResult(null)
    if (hostIds.length === 0) {
      setError(t('multiHost.selectHostsError'))
      return
    }
    if (operationMeta.target && !target.trim()) {
      setError(t('multiHost.targetRequired'))
      return
    }
    if (operationMeta.target) {
      const valid = operation === 'docker.restart'
        ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(target.trim())
        : /^[A-Za-z0-9_.@:-]+\.service$/.test(target.trim())
      if (!valid) {
        setError(t('multiHost.targetInvalid'))
        return
      }
    }
    // The orchestration callback owns the single confirmation prompt so it
    // can queue durable OperationJobs before asking and include host names,
    // risk, target and ProxyJump metadata in that prompt. The panel only
    // marks whether confirmation is required; this avoids double prompts when
    // the callback delegates to runBatchOperation.
    setRunning(true)
    setRanTarget(operationMeta.target ? target.trim() : '')
    try {
      const next = await onRunOperation({
        operation,
        hostIds: [...hostIds],
        target: operationMeta.target ? target.trim() : undefined,
        confirmationRequired: operationMeta.confirmation,
      })
      setResult(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }

  // Failed or cancelled hosts can be retried; an unknown outcome may already have run and needs checking first.
  const retryHostIds = result?.results.filter((item) => item.status === 'failed' || item.status === 'cancelled').map((item) => item.hostId).filter((id) => hostIds.has(id)) ?? []

  const selectedHosts = hosts.filter((host) => selectedHostIds.includes(host.id))
  const routeFor = (host: HostProfile) => {
    const jump = host.jumpHostId ? hosts.find((profile) => profile.id === host.jumpHostId) : null
    const target = `${host.username}@${host.address}:${host.port || 22}`
    if (jump) return `ProxyJump · ${jump.username}@${jump.address}:${jump.port || 22} → ${target}`
    if (host.jumpHost) return `ProxyJump · ${host.jumpUser || host.username}@${host.jumpHost}:${host.jumpPort || 22} → ${target}`
    return host.jumpHostId ? `ProxyJump · ${target}` : `${v3.direct} · ${target}`
  }
  const routeList = (
    <div className="space-y-1">
      {selectedHosts.map((host) => <div key={host.id} className="flex min-w-0 items-center gap-2 text-xs">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--workspace-text-subtle)]" />
        <span className="w-28 shrink-0 truncate font-medium text-[var(--workspace-text-strong)]">{host.name}</span>
        <span className="min-w-0 truncate font-mono text-[var(--workspace-text-muted)]">{routeFor(host)}</span>
      </div>)}
    </div>
  )
  const fieldLabel = 'text-xs font-medium text-[var(--workspace-text-strong)]'
  const inputClass = 'mt-1.5 h-9 w-full rounded-md border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-950)] px-2.5 text-sm text-[var(--workspace-text)] focus-visible:border-[hsl(var(--primary))] focus-visible:outline-none'
  const succeeded = result?.results.filter((item) => item.status === 'completed').length ?? 0

  return (
    <section data-testid="multi-host-operations-panel" className={cn('sb-card space-y-4 rounded-xl bg-[var(--workspace-surface-900)] p-5 text-[var(--workspace-text)]', className)}>
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--workspace-text-strong)]"><Wrench className="h-4 w-4 text-[var(--workspace-text-muted)]" />{t('multiHost.title')}</h2>
        <p className="mt-1 text-xs text-[var(--workspace-text-muted)]">{result ? t('multiHost.resultTitle') : t('multiHost.description')}</p>
      </div>

      {!result && <>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-[var(--workspace-text-strong)]">{fill(v3.batchSelected, { selected: selectedHostIds.length, max: boundedMax })}</span>
            {!selectionFromList ? <div className="flex gap-3">
              <button type="button" className="text-xs text-[var(--workspace-accent-text)] hover:underline disabled:opacity-50" onClick={selectAll} disabled={disabled || running || hosts.length === 0}>{t('multiHost.selectAll')}</button>
              <button type="button" className="text-xs text-[var(--workspace-text-muted)] hover:underline disabled:opacity-50" onClick={() => { setSelectedHostIds([]); setError('') }} disabled={disabled || running || selectedHostIds.length === 0}>{t('multiHost.clear')}</button>
            </div> : <span className="text-[11px] text-[var(--workspace-text-subtle)]">{fill(v3.batchMax, { max: boundedMax })}</span>}
          </div>
          {selectionFromList && <div className="rounded-lg border border-[color:var(--workspace-border-soft)] px-3 py-2">{routeList}</div>}
          {!selectionFromList && <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-[color:var(--workspace-border-soft)] p-1.5">
            {hosts.length === 0 ? <div className="px-2 py-6 text-center text-xs text-[var(--workspace-text-muted)]">{t('multiHost.noHosts')}</div> : hosts.map((host) => {
              const selected = selectedHostIds.includes(host.id)
              const atLimit = selectedHostIds.length >= boundedMax && !selected
              return (
                <label key={host.id} className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors', selected ? 'border-[color:var(--workspace-border-strong)] bg-[var(--workspace-accent-subtle)]' : 'border-transparent hover:bg-[var(--workspace-surface-800)]', atLimit && 'cursor-not-allowed opacity-50')}>
                  <input type="checkbox" checked={selected} onChange={() => toggleHost(host.id)} disabled={!hasSshConnection(host) || disabled || running || atLimit} className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
                  <Server className="h-3.5 w-3.5 shrink-0 text-[var(--workspace-text-subtle)]" />
                  <span className="min-w-0 flex-1 truncate font-medium text-[var(--workspace-text-strong)]">{host.name}</span>
                  <span className="max-w-40 truncate font-mono text-[11px] text-[var(--workspace-text-muted)]">{host.address}{host.jumpHostId || host.jumpHost ? ` · ${t('multiHost.proxyJump')}` : ''}</span>
                </label>
              )
            })}
          </div>}
        </div>

        <div>
          <label htmlFor="multi-host-operation" className={fieldLabel}>{t('multiHost.operation')}</label>
          <NativeSelect id="multi-host-operation" value={operation} onChange={(event) => { setOperation(event.target.value as MultiHostOperationKind); setError(''); setResult(null) }} disabled={disabled || running} className={inputClass}
            optionDetails={OPERATION_META.map((item) => ({ value: item.value, label: t(item.labelKey), description: t(item.descriptionKey) }))}>
            {OPERATION_META.map((item) => <option key={item.value} value={item.value}>{t(item.labelKey)}</option>)}
          </NativeSelect>
          <p className="mt-1.5 text-xs text-[var(--workspace-text-muted)]">{t(operationMeta.descriptionKey)} <span className="font-mono text-[var(--workspace-text-subtle)]">{commandFor(operation, '')}</span></p>
        </div>
        {operationMeta.target && (
          <div>
            <label htmlFor="multi-host-target" className={fieldLabel}>{t('multiHost.target')}</label>
            <input id="multi-host-target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={t('multiHost.targetPlaceholder')} disabled={disabled || running} className={inputClass} />
            <p className="mt-1.5 text-xs text-[var(--workspace-text-muted)]">{v3.targetHint}</p>
          </div>
        )}
        {selectedHosts.length > 0 && <div className="space-y-2 rounded-lg bg-[var(--workspace-surface-800)] p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs"><span className="font-medium text-[var(--workspace-text-strong)]">{v3.preview}</span><span className="text-[var(--workspace-text-subtle)]">{v3.previewNote}</span></div>
          <div className="rounded-md bg-[var(--workspace-surface-950)] px-3 py-2 font-mono text-xs text-[var(--workspace-text-strong)]">{commandFor(operation, target.trim())}</div>
          {!selectionFromList && routeList}
          <p className="text-[11px] text-[var(--workspace-text-subtle)]">{t('multiHost.proxyJumpNote')}</p>
        </div>}
      </>}

      {error && <div role="alert" className="flex items-start gap-2 rounded-lg bg-[var(--workspace-status-bad-bg)] px-3 py-2 text-xs text-[var(--workspace-status-bad-text)]"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}

      {result && (
        <div className="space-y-3" data-testid="multi-host-operation-result">
          <div className={cn('flex items-start gap-2.5 rounded-lg px-3.5 py-3', toneBanner[statusTone(result.status)])}>
            {result.status === 'completed' ? <CheckCircle2 className={cn('mt-0.5 h-4 w-4 shrink-0', toneText.good)} /> : <CircleAlert className={cn('mt-0.5 h-4 w-4 shrink-0', toneText[statusTone(result.status)])} />}
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--workspace-text-strong)]">{fill(v3.resultSummary, { status: t(`multiHost.status.${result.status}`), done: succeeded, total: result.results.length })}</p>
              <p className="mt-0.5 text-xs text-[var(--workspace-text-muted)]"><span className="font-mono">{commandFor(result.operation, ranTarget)}</span> · {v3.resultTransport}</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-xs">
              <thead><tr className="border-b border-[color:var(--workspace-border-soft)] text-xs font-medium text-[var(--workspace-text-subtle)]">
                <th className="px-2.5 py-2 font-medium">{v3.colHost}</th><th className="px-2.5 py-2 font-medium">{v3.colStatus}</th><th className="px-2.5 py-2 font-medium">{v3.colJob}</th><th className="px-2.5 py-2 font-medium">{v3.colSummary}</th>
              </tr></thead>
              <tbody>
                {result.results.map((item) => {
                  const host = hosts.find((candidate) => candidate.id === item.hostId)
                  const tone = statusTone(item.status)
                  return (
                    <tr key={`${item.hostId}:${item.jobId ?? item.status}`} className="border-b border-[color:var(--workspace-border-soft)] last:border-0">
                      <td className="px-2.5 py-2"><span className="font-medium text-[var(--workspace-text-strong)]">{host?.name ?? item.hostId}</span>
                        {item.transport === 'proxy-jump' && <span className="ml-1.5 rounded border border-[color:var(--workspace-border-soft)] px-1.5 py-0.5 text-[10px] text-[var(--workspace-text-muted)]">ProxyJump</span>}</td>
                      <td className="whitespace-nowrap px-2.5 py-2"><span className={cn('inline-flex items-center gap-1.5', toneText[tone])}>
                        {item.status === 'running' ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className={cn('h-1.5 w-1.5 rounded-full', toneDot[tone])} />}{t(`multiHost.status.${item.status}`)}</span></td>
                      <td className="whitespace-nowrap px-2.5 py-2 font-mono text-[11px] text-[var(--workspace-text-muted)]">
                        {item.jobId && <span>job={item.jobId}</span>}{item.jobId && item.auditId && <span aria-hidden> · </span>}{item.auditId && <span>audit={item.auditId}</span>}</td>
                      <td className="max-w-[16rem] truncate px-2.5 py-2 text-[var(--workspace-text)]">{item.errorSummary ?? item.resultSummary ?? ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-[color:var(--workspace-border-soft)] pt-3">
            <Button type="button" size="sm" variant="ghost" onClick={() => { setResult(null); setError('') }} disabled={running}>{v3.back}</Button>
            <span className="flex-1" />
            {retryHostIds.length > 0 && <Button type="button" size="sm" variant="outline" data-testid="multi-host-retry" disabled={running || disabled} onClick={() => void run(retryHostIds)}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />{t('multiHost.retryUnfinished', { count: retryHostIds.length })}
            </Button>}
          </div>
        </div>
      )}

      {!result && <div className="flex flex-wrap items-center gap-3 border-t border-[color:var(--workspace-border-soft)] pt-3">
        <p className="min-w-0 flex-1 text-xs text-[var(--workspace-text-muted)]">{t('multiHost.auditNote')}</p>
        <Button type="button" size="sm" className="bg-[color:var(--workspace-primary-500)] text-white hover:opacity-90" onClick={() => void run()} disabled={disabled || running || selectedHostIds.length === 0}>
          {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
          {running ? t('multiHost.running') : t('multiHost.run')}
        </Button>
      </div>}
    </section>
  )
}

export default MultiHostOperationsPanel
