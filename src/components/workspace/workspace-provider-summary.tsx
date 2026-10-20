import { useT } from '@/lib/i18n'
import { workspaceProviderCopy } from '@/lib/locales/workspace-provider'
import { monitoringSourcesCopy } from '@/lib/locales/monitoring-sources'
import type { WorkspaceProviderSource, WorkspaceProviderState } from '@/lib/workspace-provider-state'

function sourceKey(source: WorkspaceProviderSource) {
  return JSON.stringify([source.kind, source.id, source.nodeId ?? ''])
}

export function WorkspaceProviderSummary({ state }: { state: WorkspaceProviderState }) {
  const { t, locale } = useT()
  const copy = workspaceProviderCopy[locale]
  const sourceCopy = monitoringSourcesCopy[locale]
  const selectedKey = state.source ? sourceKey(state.source) : null
  const time = (value: number | null) => value !== null && Number.isFinite(value) && value > 0 && value <= state.now
    ? new Date(value).toLocaleString(locale)
    : copy.unknown
  const status = (health: WorkspaceProviderSource['health']) => health === 'unknown'
    ? copy.unknown
    : health === 'jump-unavailable'
      ? t('hosts.statusJumpUnavailable')
      : t(`workspace.monitor.status.${health}`)

  return <section data-testid="workspace-provider-status" aria-label={copy.title} className="mb-3 space-y-3 rounded-xl border border-[color:var(--workspace-border-soft)] bg-[var(--workspace-surface-900)] p-4 text-[var(--workspace-text)]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{sourceCopy.currentSource}</h2>
      <button type="button" disabled={state.loading} onClick={() => void state.refresh()} className="rounded border border-[color:var(--workspace-border-soft)] px-2 py-1 text-xs disabled:opacity-50">{copy.refresh}</button>
    </div>
    {state.loading && <p role="status" className="text-xs text-[var(--workspace-text-subtle)]">{copy.loading}</p>}
    {state.error && <p role="alert" className="text-xs text-[color:var(--workspace-status-warn-text)]">{copy.loadFailed}</p>}
    {!state.loading && state.sources.length === 0 && <p className="text-xs text-[var(--workspace-text-subtle)]">{copy.empty}</p>}
    {state.source && <div data-testid="workspace-current-source" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <strong>{copy[state.source.kind]}</strong>
      <span>{state.source.waitingForFirstReport ? sourceCopy.waitingForFirstReport : status(state.source.health)}</span>
      <span className="text-[var(--workspace-text-subtle)]">{copy.sampled}: {time(state.source.sampledAt)}</span>
    </div>}
    {state.source?.fallbackProvider && <p data-testid="workspace-provider-fallback" className="text-xs text-[color:var(--workspace-status-warn-text)]">{state.source.kind === 'ssh-agentless' && state.source.fallbackProvider === 'komari' ? copy.usingSsh : copy.fallbackAvailable}</p>}
    {state.sources.filter((source) => sourceKey(source) !== selectedKey && (source.waitingForFirstReport || source.health !== 'online')).map((source) => <p key={sourceKey(source)} data-testid="workspace-provider-attention" data-provider={source.kind} className="text-xs text-[var(--workspace-text-subtle)]">{copy[source.kind]} · {source.waitingForFirstReport ? sourceCopy.waitingForFirstReport : status(source.health)}</p>)}
    {state.sources.filter((source) => source.kind === 'komari' && source.syncError).map((source) => <p key={sourceKey(source)} role="status" className="text-xs text-[color:var(--workspace-status-warn-text)]">{copy.syncFailed}</p>)}
    {state.sources.length > 0 && <details data-testid="workspace-data-source-details">
      <summary className="cursor-pointer text-xs font-medium text-[var(--workspace-text-muted)]">{sourceCopy.details}</summary>
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
