import { useT } from '@/lib/i18n'
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
