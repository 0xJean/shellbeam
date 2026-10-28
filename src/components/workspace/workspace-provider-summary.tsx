import { Activity, Info, RefreshCw } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { healthDotClass } from '@/lib/workspace-overview-display'
import { workspaceProviderCopy } from '@/lib/locales/workspace-provider'
import { monitoringSourcesCopy } from '@/lib/locales/monitoring-sources'
import { workspaceOverviewCopy } from '@/lib/locales/workspace-overview'
import type { WorkspaceProviderSource, WorkspaceProviderState } from '@/lib/workspace-provider-state'

function sourceKey(source: WorkspaceProviderSource) {
  return JSON.stringify([source.kind, source.id, source.nodeId ?? ''])
}

export function WorkspaceProviderSummary({ state }: { state: WorkspaceProviderState }) {
  const { t, locale } = useT()
  const copy = workspaceProviderCopy[locale]
  const sourceCopy = monitoringSourcesCopy[locale]
  const overview = workspaceOverviewCopy[locale]
  const selectedKey = state.source ? sourceKey(state.source) : null
  const time = (value: number | null) => value !== null && Number.isFinite(value) && value > 0 && value <= state.now
    ? new Date(value).toLocaleString(locale)
    : copy.unknown
  const status = (health: WorkspaceProviderSource['health']) => health === 'unknown' || health === 'checking'
    ? overview.awaitingSample
    : health === 'jump-unavailable'
      ? t('hosts.statusJumpUnavailable')
      : health === 'offline' ? overview.monitoringUnavailable
        : health === 'stale' ? overview.monitoringStale
          : health === 'paused' ? overview.monitoringPaused
            : t(`workspace.monitor.status.${health}`)
  if (state.sources.length === 0 && !state.error) return null

  return <section data-testid="workspace-provider-status" aria-label={copy.title} className="mb-3 space-y-2 text-[var(--workspace-text)]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{overview.resources}</h2>
      {state.source && <div data-testid="workspace-current-source" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--workspace-text-subtle)]">
        <span>{overview.source}: {copy[state.source.kind]}</span>
        <span>{state.source.sampledAt ? `${copy.sampled}: ${time(state.source.sampledAt)}` : overview.sampleUnavailable}</span>
        {(state.source.waitingForFirstReport || state.source.health !== 'online') && <span>{state.source.waitingForFirstReport ? sourceCopy.waitingForFirstReport : status(state.source.health)}</span>}
      </div>}
    </div>
    {state.loading && <p role="status" className="text-xs text-[var(--workspace-text-subtle)]">{copy.loading}</p>}
    {state.error && <p role="alert" className="text-xs text-[color:var(--workspace-status-warn-text)]">{copy.loadFailed}</p>}
    {state.source?.fallbackProvider && <p data-testid="workspace-provider-fallback" className="text-xs text-[color:var(--workspace-status-warn-text)]">{state.source.kind === 'ssh-agentless' && state.source.fallbackProvider === 'komari' ? copy.usingSsh : copy.fallbackAvailable}</p>}
    {state.sources.filter((source) => sourceKey(source) !== selectedKey && (source.waitingForFirstReport || source.health !== 'online')).map((source) => <p key={sourceKey(source)} data-testid="workspace-provider-attention" data-provider={source.kind} className="text-xs text-[var(--workspace-text-subtle)]">{copy[source.kind]} · {source.waitingForFirstReport ? sourceCopy.waitingForFirstReport : status(source.health)}</p>)}
    {state.sources.filter((source) => source.kind === 'komari' && source.syncError).map((source) => <p key={sourceKey(source)} role="status" className="text-xs text-[color:var(--workspace-status-warn-text)]">{copy.syncFailed}</p>)}
    {(state.sources.length > 0 || state.error) && <details key={JSON.stringify([state.view?.host.vaultId, state.view?.host.id, state.view?.host.address, state.view?.host.port, state.view?.host.username, state.view?.host.jumpHostId])} data-testid="workspace-data-source-details">
      <summary className="cursor-pointer text-xs font-medium text-[var(--workspace-text-muted)]">{sourceCopy.details}</summary>
      <button type="button" disabled={state.loading} onClick={() => void state.refresh()} className="mt-3 rounded border border-[color:var(--workspace-border-soft)] px-2 py-1 text-xs disabled:opacity-50">{copy.refresh}</button>
      {state.telemetry && <p data-testid="workspace-probe-telemetry" className="mt-2 text-xs text-[var(--workspace-text-subtle)]">
        {t(`workspace.probeTelemetry.status.${state.telemetry.status}`)}
        {' · '}{t('workspace.probeTelemetry.attempts', { count: state.telemetry.attempts })}
        {' · '}{t('workspace.probeTelemetry.duration', { ms: state.telemetry.durationMs })}
      </p>}
    <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3">
      {state.sources.map((source) => {
        const selected = selectedKey === sourceKey(source)
        return <article key={sourceKey(source)} data-testid="workspace-provider-source" data-provider={source.kind} data-selected={selected} data-health={source.health} className={`min-w-0 rounded-lg border p-3 ${selected ? 'border-primary/50 bg-primary/5' : 'border-[color:var(--workspace-border-soft)]'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <strong>{copy[source.kind]}</strong>
            <span>{source.waitingForFirstReport ? sourceCopy.waitingForFirstReport : status(source.health)}</span>
          </div>
          <div className="mt-1 text-xs text-[var(--workspace-text-subtle)]">{selected ? copy.selected : copy.available}</div>
          <div className="mt-1 truncate font-mono text-[10px] text-[var(--workspace-text-subtle)]" title={source.id}>{source.id}{source.nodeId ? ` · ${source.nodeId}` : ''}</div>
          <dl className="mt-2 grid grid-cols-[auto,minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt>{copy.sampled}</dt><dd data-testid="workspace-provider-sampled" className="break-words">{time(source.sampledAt)}</dd>
            <dt>{copy.received}</dt><dd className="break-words">{time(source.receivedAt)}</dd>
            {source.kind === 'komari' && <><dt>{copy.synced}</dt><dd data-testid="workspace-provider-synced" className="break-words">{time(source.lastSyncedAt)}</dd></>}
            <dt>TTL</dt><dd>{source.ttlMs !== null && Number.isFinite(source.ttlMs) && source.ttlMs >= 0 ? `${source.ttlMs / 1000}s` : copy.unknown}</dd>
            <dt>{copy.confidence}</dt><dd>{source.confidence ? copy[source.confidence] : copy.unknown}</dd>
          </dl>
          <div className="mt-2 flex flex-wrap gap-1" aria-label={copy.capabilities}>
            {source.capabilities.length > 0 ? source.capabilities.map((capability) => <span key={capability} className="rounded border border-[color:var(--workspace-border-soft)] px-1.5 py-0.5 text-[10px]">{copy[capability]}</span>) : <span className="text-xs text-[var(--workspace-text-subtle)]">{copy.noCapabilities}</span>}
          </div>
        </article>
      })}
    </div>
    <p className="mt-3 text-[11px] text-[var(--workspace-text-subtle)]">{copy.observationHint}</p>
    </details>}
  </section>
}

/** v3 overview card: every observation source as its own row, the selected one outlined. */
export function WorkspaceDataSourcesCard({ state, className }: { state: WorkspaceProviderState; className?: string }) {
  const { t, locale } = useT()
  const copy = workspaceProviderCopy[locale]
  const sourceCopy = monitoringSourcesCopy[locale]
  const overview = workspaceOverviewCopy[locale]
  const selectedKey = state.source ? sourceKey(state.source) : null
  const time = (value: number | null) => value !== null && Number.isFinite(value) && value > 0 && value <= state.now
    ? new Date(value).toLocaleTimeString(locale)
    : copy.unknown
  const status = (source: WorkspaceProviderSource) => source.waitingForFirstReport ? sourceCopy.waitingForFirstReport
    : source.health === 'unknown' || source.health === 'checking' ? overview.awaitingSample
      : source.health === 'jump-unavailable' ? t('hosts.statusJumpUnavailable')
        : source.health === 'offline' ? overview.monitoringUnavailable
          : source.health === 'stale' ? overview.monitoringStale
            : source.health === 'paused' ? overview.monitoringPaused
              : t(`workspace.monitor.status.${source.health}`)
  return <section data-testid="workspace-data-sources" aria-label={overview.dataSources} className={cn('sb-card flex min-w-0 flex-col', className)}>
    <div className="flex items-center justify-between gap-2 border-b border-[color:var(--workspace-border-soft)] px-4 py-2.5">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--workspace-text-strong)]">{overview.dataSources}<span title={overview.dataSourcesHint} className="text-[var(--workspace-text-subtle)]"><Info className="h-3.5 w-3.5" aria-label={overview.dataSourcesHint} /></span></h3>
      <button type="button" disabled={state.loading} onClick={() => void state.refresh()} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--workspace-text)] hover:bg-[var(--workspace-nav-hover-bg)] disabled:opacity-50">
        <RefreshCw className={cn('h-3.5 w-3.5', state.loading && 'animate-spin')} aria-hidden="true" />{copy.refresh}
      </button>
    </div>
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
      {state.telemetry && <p data-testid="workspace-probe-telemetry" className="flex items-center gap-1.5 text-[11.5px] text-[var(--workspace-text-muted)]">
        <Activity className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{t(`workspace.probeTelemetry.status.${state.telemetry.status}`)} · {t('workspace.probeTelemetry.attempts', { count: state.telemetry.attempts })} · {t('workspace.probeTelemetry.duration', { ms: state.telemetry.durationMs })}{state.source?.fallbackProvider ? ` · ${copy.fallbackAvailable}` : ''}</span>
      </p>}
      {state.error && <p role="alert" className="text-xs text-[color:var(--workspace-status-warn-text)]">{copy.loadFailed}</p>}
      {state.sources.length === 0 && !state.error && <p className="text-xs text-[var(--workspace-text-muted)]">{state.loading ? copy.loading : copy.empty}</p>}
      {state.sources.map((source) => {
        const selected = selectedKey === sourceKey(source)
        return <article key={sourceKey(source)} data-testid="workspace-provider-source" data-provider={source.kind} data-selected={selected} data-health={source.health}
          className={cn('flex min-w-0 flex-col gap-1.5 rounded-md border px-3 py-2', selected ? 'border-[color:var(--workspace-primary-500)] shadow-[0_0_0_2px_var(--workspace-accent-subtle)]' : 'border-[color:var(--workspace-border-soft)]')}>
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] font-semibold text-[var(--workspace-text-strong)]">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', healthDotClass(source.waitingForFirstReport ? 'unknown' : source.health))} aria-hidden="true" />
            <span className="truncate">{copy[source.kind]}</span>
            <span className="flex-1" />
            <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium', selected ? 'bg-[var(--workspace-accent-subtle)] text-[var(--workspace-accent-text)]' : 'bg-[var(--workspace-surface-800)] text-[var(--workspace-text-muted)]')}>{selected ? copy.selected : copy.available}</span>
            {source.confidence && <span className="shrink-0 rounded border border-[color:var(--workspace-border-soft)] px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--workspace-text-muted)]">{copy[source.confidence]}</span>}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--workspace-text-muted)]">
            {(source.waitingForFirstReport || source.health !== 'online') && <span>{status(source)}</span>}
            <span data-testid="workspace-provider-sampled">{copy.sampled} {time(source.sampledAt)}</span>
            {source.receivedAt !== null && <span>{copy.received} {time(source.receivedAt)}</span>}
            {source.kind === 'komari' && <span data-testid="workspace-provider-synced">{copy.synced} {time(source.lastSyncedAt)}</span>}
            {source.ttlMs !== null && Number.isFinite(source.ttlMs) && source.ttlMs >= 0 && <span>TTL {Math.round(source.ttlMs / 1000)}s</span>}
            <span className="ml-auto flex flex-wrap gap-1" aria-label={copy.capabilities}>
              {source.capabilities.length > 0 ? source.capabilities.map((capability) => <span key={capability} className="rounded bg-[var(--workspace-surface-800)] px-1.5 text-[10.5px] leading-[18px] text-[var(--workspace-text)]">{copy[capability]}</span>) : <span>{copy.noCapabilities}</span>}
            </span>
          </div>
          {source.kind === 'komari' && source.syncError && <p role="status" className="text-[11px] text-[color:var(--workspace-status-warn-text)]">{copy.syncFailed}</p>}
        </article>
      })}
    </div>
  </section>
}
