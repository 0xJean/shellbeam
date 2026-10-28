import { NativeSelect } from '@/components/ui/select'
import { hasSshConnection } from '@/lib/hosts'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { HostProfile } from '@/lib/hosts'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { MAX_BATCH_HOSTS } from '@/lib/multi-host-operations'
import { CheckCircle2, CircleAlert, Loader2, RotateCcw, Server, Square, Wrench } from 'lucide-react'

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

function resultTone(status: MultiHostOperationHostStatus | MultiHostOperationStatus) {
  if (status === 'completed') return 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
  if (status === 'failed' || status === 'unknown') return 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300'
  if (status === 'running') return 'border-blue-500/30 bg-blue-500/5 text-blue-700 dark:text-blue-300'
  return 'border-border/60 bg-muted/20 text-muted-foreground'
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
  const { t } = useT()
  const boundedMax = Math.max(1, Math.min(MAX_BATCH_HOSTS, Number.isFinite(maxHosts) ? Math.floor(maxHosts) : MAX_BATCH_HOSTS))
  const hostIds = useMemo(() => new Set(hosts.map((host) => host.id)), [hosts])
  const [selectedHostIds, setSelectedHostIds] = useState<string[]>(() => initialSelectedHostIds.filter((id) => hostIds.has(id)).slice(0, boundedMax))
  const [operation, setOperation] = useState<MultiHostOperationKind>(initialOperation)
  const [target, setTarget] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<MultiHostOperationResult | null>(null)

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

  return (
    <section data-testid="multi-host-operations-panel" className={cn('space-y-4 rounded-xl border border-border/60 bg-card px-4 py-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Wrench className="h-4 w-4" />{t('multiHost.title')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('multiHost.description')}</p>
        </div>
        <span className="rounded-full border border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
          {t('multiHost.selectedCount', { selected: selectedHostIds.length, max: boundedMax })}
        </span>
      </div>

      {selectionFromList && <p className="text-sm">{hosts.filter(host => selectedHostIds.includes(host.id)).map(host => host.name).join(' · ')}</p>}
      <div className={cn('grid gap-4', !selectionFromList && 'lg:grid-cols-[minmax(0,1.2fr)_minmax(14rem,0.8fr)]')}>
        {!selectionFromList && <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-foreground">{t('multiHost.hosts')}</div>
            <div className="flex gap-2">
              <button type="button" className="text-[11px] text-primary hover:underline disabled:opacity-50" onClick={selectAll} disabled={disabled || running || hosts.length === 0}>{t('multiHost.selectAll')}</button>
              <button type="button" className="text-[11px] text-muted-foreground hover:underline disabled:opacity-50" onClick={() => { setSelectedHostIds([]); setError('') }} disabled={disabled || running || selectedHostIds.length === 0}>{t('multiHost.clear')}</button>
            </div>
          </div>
          <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border border-border/50 p-2">
            {hosts.length === 0 ? <div className="px-2 py-6 text-center text-xs text-muted-foreground">{t('multiHost.noHosts')}</div> : hosts.map((host) => {
              const selected = selectedHostIds.includes(host.id)
              const atLimit = selectedHostIds.length >= boundedMax && !selected
              return (
                <label key={host.id} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors', selected ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:bg-muted/40', atLimit && 'cursor-not-allowed opacity-50')}>
                  <input type="checkbox" checked={selected} onChange={() => toggleHost(host.id)} disabled={!hasSshConnection(host) || disabled || running || atLimit} className="h-3.5 w-3.5 accent-primary" />
                  <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium">{host.name}</span>
                  <span className="max-w-40 truncate text-[11px] text-muted-foreground">{host.address}{host.jumpHostId || host.jumpHost ? ` · ${t('multiHost.proxyJump')}` : ''}</span>
                </label>
              )
            })}
          </div>
        </div>}

        <div className="space-y-3 rounded-lg border border-border/50 p-3">
          <div>
            <label htmlFor="multi-host-operation" className="text-xs font-semibold text-foreground">{t('multiHost.operation')}</label>
            <NativeSelect id="multi-host-operation" value={operation} onChange={(event) => { setOperation(event.target.value as MultiHostOperationKind); setError(''); setResult(null) }} disabled={disabled || running} className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-2 text-xs">
              {OPERATION_META.map((item) => <option key={item.value} value={item.value}>{t(item.labelKey)}</option>)}
            </NativeSelect>
            <p className="mt-1.5 text-[11px] text-muted-foreground">{t(operationMeta.descriptionKey)}</p>
          </div>
          {operationMeta.target && (
            <div>
              <label htmlFor="multi-host-target" className="text-xs font-semibold text-foreground">{t('multiHost.target')}</label>
              <input id="multi-host-target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={t('multiHost.targetPlaceholder')} disabled={disabled || running} className="mt-1.5 h-9 w-full rounded-md border border-input bg-background px-2 text-xs" />
            </div>
          )}
          <Button type="button" size="sm" className="w-full" onClick={() => void run()} disabled={disabled || running || selectedHostIds.length === 0}>
            {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wrench className="mr-1.5 h-3.5 w-3.5" />}
            {running ? t('multiHost.running') : t('multiHost.run')}
          </Button>
          <p className="text-[11px] text-muted-foreground">{t('multiHost.auditNote')}</p>
        </div>
      </div>

      {error && <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</div>}
      {result && (
        <div className="space-y-2 rounded-lg border border-border/50 p-3" data-testid="multi-host-operation-result">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-foreground">{t('multiHost.resultTitle')}</div>
            <span className="flex items-center gap-2">
              {retryHostIds.length > 0 && <button type="button" data-testid="multi-host-retry" disabled={running || disabled} onClick={() => void run(retryHostIds)}
                className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium hover:bg-muted/50 disabled:opacity-50">
                <RotateCcw className="h-3 w-3" />{t('multiHost.retryUnfinished', { count: retryHostIds.length })}
              </button>}
              <span className={cn('rounded-full border px-2 py-1 text-[10px] uppercase', resultTone(result.status))}>{t(`multiHost.status.${result.status}`)}</span>
            </span>
          </div>
          <div className="space-y-1.5">
            {result.results.map((item) => {
              const host = hosts.find((candidate) => candidate.id === item.hostId)
              return (
                <div key={`${item.hostId}:${item.jobId ?? item.status}`} className={cn('flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-xs', resultTone(item.status))}>
                  {item.status === 'completed' ? <CheckCircle2 className="h-3.5 w-3.5" /> : item.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                  <span className="font-medium">{host?.name ?? item.hostId}</span>
                  <span className="text-[11px] opacity-80">{t(`multiHost.status.${item.status}`)}</span>
                  {item.jobId && <span className="ml-auto font-mono text-[10px] opacity-80">job={item.jobId}</span>}
                  {item.auditId && <span className="font-mono text-[10px] opacity-80">audit={item.auditId}</span>}
                  {item.transport === 'proxy-jump' && <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px]">ProxyJump</span>}
                  {(item.errorSummary || item.resultSummary) && <span className="basis-full truncate text-[11px] opacity-80">{item.errorSummary ?? item.resultSummary}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {selectedHostIds.length > 0 && <p className="text-[11px] text-muted-foreground">{t('multiHost.proxyJumpNote')}</p>}
    </section>
  )
}

export default MultiHostOperationsPanel
